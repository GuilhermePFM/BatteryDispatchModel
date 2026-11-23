"""The solver Lambda: one job message off SQS in, one finished run out.

The event source hands over one message at a time (batch size 1). The run
moves ``queued → running`` on a condition, so a redelivered message finds it
already taken and does nothing. The eight programs of the portfolio then run
with their progress written to the run, and the run ends one of three ways
(``contracts/platform.md``, "Finishing a run"):

* solved: every plan goes to ``plans/<run_id>.csv`` and the run is
  ``succeeded`` with ``result_json``, the v2 result as compact JSON. The solve
  is given the invocation's remaining time less :data:`FINISH_MARGIN`;
* the user's mistake or a stale message — a price file :func:`parse_pld`
  rejects, dates outside the prices, a message from another contract or model
  version — or a solve out of time: the run is ``failed`` and its quota
  refunded, and the handler returns normally so the message is not retried;
* anything else raises: the message goes to the DLQ, whose handler fails the
  run with ``solver_failed`` and refunds it.

``local_worker.py`` calls :func:`handler` the same way against LocalStack.
"""

from __future__ import annotations

import dataclasses
import functools
import hashlib
import json
import logging
import os
import random
import time
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any

import boto3
import pandas as pd
from boto3.dynamodb.types import TypeSerializer
from botocore.exceptions import ClientError
from jsonschema import Draft202012Validator
from referencing import Registry, Resource

from battery_plan.contracts import (
    BUNDLED_PLD_SHA256,
    CONTRACT_VERSION,
    MODEL_VERSION,
    check_span,
    hourly_battery_from_request,
)
from battery_plan.data_io import PLD_HOURLY_CSV, PldFileError, parse_pld
from battery_plan.modelling.portfolio import CaseProgress, solve_portfolio
from battery_plan.result_v2 import MAX_RESULT_BYTES, build_result, plan_csv

log = logging.getLogger("solver")
log.setLevel(logging.INFO)

#: The JSON Schemas; the image copies them next to the handler.
CONTRACTS_DIR = Path(
    os.environ.get("CONTRACTS_DIR", Path(__file__).resolve().parents[2] / "contracts")
)
#: The bundled hourly PLD; the image copies it next to the handler.
PLD_CSV = Path(os.environ.get("PLD_CSV", PLD_HOURLY_CSV))

#: Seconds of the invocation kept back from the solve for what follows it:
#: building the result, the plan CSV to S3, the success write.
FINISH_MARGIN = 45.0
#: What the user reads when the eight programs do not fit in the invocation.
TIMEOUT_MESSAGE = (
    "This run did not finish in the time available and has not counted against your "
    "daily runs. Try a shorter duration or fewer days."
)
#: What the user reads when a run was queued under another contract or model version.
STALE_MESSAGE = (
    "This run was queued for an earlier version of the model and has not counted "
    "against your daily runs. Submit it again."
)
#: Tries at the fail-and-refund transaction while concurrent writes cancel it.
_FAIL_ATTEMPTS = 10

_serialize = TypeSerializer().serialize


def handler(event: dict[str, Any], context: object = None) -> None:
    """Lambda entry point for an SQS event."""
    for record in event["Records"]:
        process(json.loads(record["body"]), deadline=_deadline(context))


def _deadline(context: object) -> float | None:
    """The :func:`time.perf_counter` reading the solve must end by, from Lambda's clock.

    The invocation's remaining time less :data:`FINISH_MARGIN` for the writes
    after the solve; ``None`` without a Lambda context (a test, a script).
    """
    remaining = getattr(context, "get_remaining_time_in_millis", None)
    if remaining is None:
        return None
    return time.perf_counter() + float(remaining()) / 1000.0 - FINISH_MARGIN


def process(message: dict[str, Any], deadline: float | None = None) -> None:
    """Run one job message to the end, as ``contracts/platform.md`` lays out.

    ``deadline`` (a :func:`time.perf_counter` reading) is when the solve must
    be over. A portfolio that would run past it fails the run and refunds it.
    """
    if (message.get("version"), message.get("model_version")) != (CONTRACT_VERSION, MODEL_VERSION):
        _refuse_stale(message)
        return
    _validator().validate(message)
    run_id, request = message["run_id"], message["request"]
    run = _start(run_id)
    if run is None:
        log.info("run %s is no longer queued: a redelivery, skipped", run_id)
        return

    try:
        prices = _prices(message["prices"])
    except PldFileError as error:
        _fail(run, "prices_invalid", str(error))
        return
    try:
        window = _window(prices, request)
    except ValueError as error:
        _fail(run, "request_invalid", str(error))
        return

    progress = _Progress(run_id)
    battery = hourly_battery_from_request(request)
    started = time.perf_counter()
    limit = None if deadline is None else deadline - started
    try:
        portfolio = solve_portfolio(window, battery, time_limit=limit, on_case=progress)
    except TimeoutError:
        log.warning("run %s ran out of time", run_id)
        _fail(run, "solver_failed", TIMEOUT_MESSAGE)
        return
    elapsed = time.perf_counter() - started
    result = json.dumps(
        build_result(portfolio, battery, request, elapsed),
        separators=(",", ":"),
        allow_nan=False,
    )
    if len(result.encode()) > MAX_RESULT_BYTES:
        raise RuntimeError(f"run {run_id}: the result is {len(result.encode())} bytes")

    plan_key = f"plans/{run_id}.csv"
    _aws().s3.put_object(
        Bucket=os.environ["DATA_BUCKET"],
        Key=plan_key,
        Body=plan_csv(portfolio),
        ContentType="text/csv",
    )
    now = _now()
    _update(
        run_id,
        "SET #status = :succeeded, result_json = :result, plan_csv_key = :key, "
        "progress = :progress, finished_at = :now, updated_at = :now",
        succeeded="succeeded",
        result=result,
        key=plan_key,
        progress=progress.final(now, elapsed),
        now=now,
    )
    log.info("run %s succeeded in %.1f s", run_id, elapsed)


def _refuse_stale(message: dict[str, Any]) -> None:
    """Fail and refund a run queued under another contract or model version.

    A message without a run id has no run to fail, so it raises and the DLQ
    handler drops it.
    """
    run_id = message.get("run_id")
    if not isinstance(run_id, str) or not run_id:
        raise ValueError("a job message without a run_id")
    run = _start(run_id)
    if run is None:
        log.info("run %s is no longer queued: a stale redelivery, skipped", run_id)
        return
    _fail(run, "request_invalid", STALE_MESSAGE)


def _start(run_id: str) -> dict[str, Any] | None:
    """Move the run ``queued → running``; ``None`` when it was not queued."""
    now = _now()
    try:
        reply = _update(
            run_id,
            "SET #status = :running, started_at = :now, updated_at = :now",
            condition="#status = :queued",
            returns="ALL_NEW",
            running="running",
            queued="queued",
            now=now,
        )
    except ClientError as error:
        if error.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return None
        raise
    strings = {name: value["S"] for name, value in reply["Attributes"].items() if "S" in value}
    return {**strings, "run_id": run_id}


def _fail(run: dict[str, Any], code: str, message: str) -> None:
    """Fail the run and refund its quota, once, whoever gets there first.

    The status change and the two refunds are one transaction, conditional on
    the run still being in flight; the cache pointer is dropped afterwards,
    and only while it still points at this run.
    """
    now, day = _now(), run["created_at"][:10]
    table = os.environ["TABLE_NAME"]
    refund = {
        "UpdateExpression": "ADD used :minus_one",
        "ExpressionAttributeValues": {":minus_one": {"N": "-1"}},
    }
    items = [
        {
            "Update": {
                "TableName": table,
                "Key": {"pk": {"S": f"run#{run['run_id']}"}},
                "UpdateExpression": "SET #status = :failed, #error = :error, "
                "finished_at = :now, updated_at = :now",
                "ConditionExpression": "#status IN (:queued, :running)",
                "ExpressionAttributeNames": {"#status": "status", "#error": "error"},
                "ExpressionAttributeValues": _values(
                    failed="failed",
                    error={"code": code, "message": message[:2000]},
                    now=now,
                    queued="queued",
                    running="running",
                ),
            }
        },
        {
            "Update": {
                "TableName": table,
                "Key": {"pk": {"S": f"quota#{run['user_sub']}#{day}"}},
                **refund,
            }
        },
        {"Update": {"TableName": table, "Key": {"pk": {"S": f"global#{day}"}}, **refund}},
    ]
    for attempt in range(_FAIL_ATTEMPTS):
        try:
            _aws().dynamodb.transact_write_items(TransactItems=items)
            break
        except ClientError as error:
            if error.response["Error"]["Code"] != "TransactionCanceledException":
                raise
            reasons = [r.get("Code") for r in error.response.get("CancellationReasons", [])]
            if reasons and reasons[0] == "ConditionalCheckFailed":
                log.info("run %s was already finished: no refund", run["run_id"])
                return
            # A concurrent transaction (a submission on the same counters, the
            # DLQ handler) touched these items: back off and retry.
            if attempt + 1 == _FAIL_ATTEMPTS or not (
                {"TransactionConflict", "ThrottlingError"} & set(reasons)
            ):
                raise
            time.sleep(0.01 * 2 ** min(attempt, 5) + random.random() * 0.02)
    try:
        _aws().dynamodb.delete_item(
            TableName=table,
            Key={"pk": {"S": f"hash#{run['params_hash']}"}},
            ConditionExpression="run_id = :run_id",
            ExpressionAttributeValues=_values(run_id=run["run_id"]),
        )
    except ClientError as error:
        if error.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise
    log.info("run %s failed (%s), quota refunded: %s", run["run_id"], code, message)


class _Progress:
    """The ``on_case`` callback: writes which of the programs is in flight.

    There are at most eight, each taking a second or more, so every one is
    written. The final state goes out with the success itself.
    """

    def __init__(self, run_id: str) -> None:
        self.run_id = run_id
        self.total = 0

    def __call__(self, event: CaseProgress) -> None:
        self.total = event.cases_total
        now = _now()
        _update(
            self.run_id,
            "SET progress = :progress, updated_at = :now",
            progress={
                "phase": "solving",
                "cases_done": event.cases_done,
                "cases_total": event.cases_total,
                "submarket": event.submarket,
                "case": event.case.value,
                "fraction": event.cases_done / event.cases_total,
                "elapsed": event.elapsed,
                "done": False,
                "updated_at": now,
            },
            now=now,
        )

    def final(self, now: str, elapsed: float) -> dict[str, Any]:
        return {
            "phase": "done",
            "cases_done": self.total,
            "cases_total": self.total,
            "submarket": None,
            "case": None,
            "fraction": 1,
            "elapsed": elapsed,
            "done": True,
            "updated_at": now,
        }


def _prices(source: dict[str, str]) -> pd.DataFrame:
    if source["source"] == "bundled":
        return _bundled_prices()
    body = _aws().s3.get_object(Bucket=source["bucket"], Key=source["key"])["Body"].read()
    return parse_pld(body)


@functools.cache
def _bundled_prices() -> pd.DataFrame:
    """Read once per container: a warm Lambda keeps them.

    The image holds the file at its own path, so the pin is checked here.
    """
    data = PLD_CSV.read_bytes()
    if hashlib.sha256(data).hexdigest() != BUNDLED_PLD_SHA256:
        raise RuntimeError(f"{PLD_CSV} does not match its pinned sha256")
    return parse_pld(data)


def _window(prices: pd.DataFrame, request: dict[str, Any]) -> pd.DataFrame:
    """The whole days of the request, which must lie inside the prices."""
    check_span(request)
    first, last = pd.Timestamp(request["start"]), pd.Timestamp(request["end"])
    after = last + pd.Timedelta(days=1)
    if first < prices.index[0] or after - pd.Timedelta(hours=1) > prices.index[-1]:
        raise ValueError(
            f"The dates {request['start']} to {request['end']} are not all inside the prices, "
            f"which run from {prices.index[0]:%Y-%m-%d %H:%M} to {prices.index[-1]:%Y-%m-%d %H:%M}."
        )
    return prices.loc[(prices.index >= first) & (prices.index < after)]


def _update(
    run_id: str,
    expression: str,
    *,
    condition: str | None = None,
    returns: str = "NONE",
    **values: Any,
) -> dict[str, Any]:
    """An ``UpdateItem`` on the run, with ``:name`` values given as keywords."""
    extra = {"ConditionExpression": condition} if condition else {}
    names = {"#status": "status"} if "#status" in expression + (condition or "") else {}
    reply: dict[str, Any] = _aws().dynamodb.update_item(
        TableName=os.environ["TABLE_NAME"],
        Key={"pk": {"S": f"run#{run_id}"}},
        UpdateExpression=expression,
        ExpressionAttributeValues=_values(**values),
        ReturnValues=returns,
        **({"ExpressionAttributeNames": names} if names else {}),
        **extra,
    )
    return reply


def _values(**values: Any) -> dict[str, Any]:
    """DynamoDB attribute values; floats go through ``Decimal``, as the SDK requires."""
    return {
        f":{name}": _serialize(json.loads(json.dumps(value), parse_float=Decimal))
        for name, value in values.items()
    }


def _now() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


@dataclasses.dataclass(frozen=True)
class _Clients:
    dynamodb: Any
    s3: Any


@functools.cache
def _aws() -> _Clients:
    """The SDK clients, made on first use; ``AWS_ENDPOINT_URL`` points them at LocalStack."""
    return _Clients(dynamodb=boto3.client("dynamodb"), s3=boto3.client("s3"))


@functools.cache
def _validator() -> Draft202012Validator:
    """The job-message schema, with the other schemas registered for its ``$ref`` s."""
    paths = (CONTRACTS_DIR / "v2").glob("*.schema.json")
    schemas = [json.loads(path.read_text()) for path in paths]
    registry: Registry = Registry().with_resources(
        (schema["$id"], Resource.from_contents(schema)) for schema in schemas
    )
    job = next(s for s in schemas if s["$id"].endswith("/job-message.schema.json"))
    return Draft202012Validator(job, registry=registry)
