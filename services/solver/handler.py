"""The solver Lambda: one job message off SQS in, one finished run out.

The event source hands over one message at a time (batch size 1). The run
moves ``queued → running`` on a condition, so a redelivered message finds it
already taken and does nothing. The dispatch then runs with its progress
written to the run every few seconds, and the run ends one of three ways
(``contracts/platform.md``, "Finishing a run"):

* solved: the plan CSV goes to ``plans/<run_id>.csv`` and the run is
  ``succeeded`` with ``result_json``, the result payload as compact JSON;
* the user's mistake — a price file :func:`load_market_prices_csv` rejects, or
  dates outside the prices — the run is ``failed`` and its quota refunded, and
  the handler returns normally so the message is not retried;
* anything else raises: the message goes to the DLQ, whose handler fails the
  run with ``solver_failed`` and refunds it.

``local_worker.py`` calls :func:`handler` the same way against LocalStack.
"""

from __future__ import annotations

import dataclasses
import functools
import io
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

from battery_plan.analysis import build_result_payload
from battery_plan.contracts import config_from_request, spec_from_request
from battery_plan.data_io import (
    MARKET_PRICES_XLSX,
    PriceFileError,
    load_market_prices,
    load_market_prices_csv,
)
from battery_plan.data_models import MarketPrices
from battery_plan.dispatch import run_dispatch
from battery_plan.reporting import ProgressEvent

log = logging.getLogger("solver")
log.setLevel(logging.INFO)

#: The JSON Schemas; the image copies them next to the handler.
CONTRACTS_DIR = Path(
    os.environ.get("CONTRACTS_DIR", Path(__file__).resolve().parents[2] / "contracts")
)
#: The bundled 2018-2020 prices; the image copies them next to the handler.
PRICES_XLSX = Path(os.environ.get("PRICES_XLSX", MARKET_PRICES_XLSX))

#: Seconds between progress writes: the callback fires once per solved window.
PROGRESS_INTERVAL = 3.0
#: Tries at the fail-and-refund transaction while concurrent writes cancel it.
_FAIL_ATTEMPTS = 10

_serialize = TypeSerializer().serialize


def handler(event: dict[str, Any], context: object = None) -> None:
    """Lambda entry point for an SQS event."""
    for record in event["Records"]:
        process(json.loads(record["body"]))


def process(message: dict[str, Any]) -> None:
    """Run one job message to the end, as ``contracts/platform.md`` lays out."""
    _validator().validate(message)
    run_id, request = message["run_id"], message["request"]
    run = _start(run_id)
    if run is None:
        log.info("run %s is no longer queued: a redelivery, skipped", run_id)
        return

    try:
        prices = _prices(message["prices"])
    except PriceFileError as error:
        _fail(run, "prices_invalid", str(error))
        return
    try:
        _check_dates(prices, request)
    except ValueError as error:
        _fail(run, "request_invalid", str(error))
        return

    progress = _Progress(run_id)
    spec = spec_from_request(request)
    solved = run_dispatch(spec, prices, config_from_request(request), progress)
    result = build_result_payload(solved.plan, spec, solved.params, solved.search)

    plan_key = f"plans/{run_id}.csv"
    _aws().s3.put_object(
        Bucket=os.environ["DATA_BUCKET"],
        Key=plan_key,
        Body=solved.plan.to_csv().encode(),
        ContentType="text/csv",
    )
    now = _now()
    _update(
        run_id,
        "SET #status = :succeeded, result_json = :result, plan_csv_key = :key, "
        "progress = :progress, finished_at = :now, updated_at = :now",
        succeeded="succeeded",
        result=json.dumps(result, separators=(",", ":"), allow_nan=False),
        key=plan_key,
        progress=progress.record(now),
        now=now,
    )
    log.info("run %s succeeded in %.1f s", run_id, solved.elapsed)


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
    """The ``on_progress`` callback: keeps the latest event, writes it every few seconds.

    The final event is not written here: it goes out with the success itself.
    """

    def __init__(self, run_id: str) -> None:
        self.run_id = run_id
        self.latest: ProgressEvent | None = None
        self.written = time.monotonic()

    def __call__(self, event: ProgressEvent) -> None:
        self.latest = event
        if event.done or time.monotonic() - self.written < PROGRESS_INTERVAL:
            return
        self.written = time.monotonic()
        now = _now()
        _update(
            self.run_id,
            "SET progress = :progress, updated_at = :now",
            progress=self.record(now),
            now=now,
        )

    def record(self, now: str) -> dict[str, Any] | None:
        return (
            None if self.latest is None else {**dataclasses.asdict(self.latest), "updated_at": now}
        )


def _prices(source: dict[str, str]) -> MarketPrices:
    if source["source"] == "bundled":
        return _bundled_prices()
    body = _aws().s3.get_object(Bucket=source["bucket"], Key=source["key"])["Body"].read()
    return load_market_prices_csv(io.BytesIO(body))


@functools.cache
def _bundled_prices() -> MarketPrices:
    """Read once per container: a warm Lambda keeps them."""
    return load_market_prices(PRICES_XLSX)


def _check_dates(prices: MarketPrices, request: dict[str, Any]) -> None:
    """Both dates inside the prices, which the API cannot check on an upload."""
    first, last = pd.Timestamp(request["start"]), pd.Timestamp(request["end"])
    if first < prices.start or last + pd.Timedelta(hours=23, minutes=30) > prices.end:
        raise ValueError(
            f"The dates {request['start']} to {request['end']} are not all inside the prices, "
            f"which run from {prices.start:%Y-%m-%d %H:%M} to {prices.end:%Y-%m-%d %H:%M}."
        )


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
    schemas = [json.loads(path.read_text()) for path in CONTRACTS_DIR.glob("*.schema.json")]
    registry: Registry = Registry().with_resources(
        (schema["$id"], Resource.from_contents(schema)) for schema in schemas
    )
    job = next(s for s in schemas if s["$id"].endswith("/job-message.schema.json"))
    return Draft202012Validator(job, registry=registry)
