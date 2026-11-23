"""The solver Lambda's handler (``services/solver/handler.py``) against moto's AWS.

Every run here is on a synthetic year of PLD uploaded to the mocked bucket. The
year is the shortest horizon a v2 request may ask for, and solving its eight
programs takes seconds, so one solve is shared and most tests are about what
happens around it: the conditional start, the success record, the refund on a
user error or a stale message, and the raise on anything else.
"""

from __future__ import annotations

import json
import time
from collections.abc import Callable, Iterator
from typing import Any

import boto3
import numpy as np
import pandas as pd
import pytest
from botocore.exceptions import ClientError
from jsonschema import Draft202012Validator, FormatChecker
from moto import mock_aws
from referencing import Registry, Resource

import handler
from battery_plan.contracts import (
    BUNDLED_PLD_SHA256,
    hourly_battery_from_request,
    prices_sha256,
)
from battery_plan.data_io import PLD_CSV_HEADER, SUBMARKETS, parse_pld
from battery_plan.data_io.paths import PROJECT_ROOT
from battery_plan.modelling.portfolio import (
    BusinessCase,
    CaseProgress,
    Portfolio,
    solve_portfolio,
)

TABLE = "batteryplan"
BUCKET = "batteryplan-data"
RUN_ID = "01JD3X7Q8RZK5V2N4M6P9T0WYA"
SUB = "user-1"
DAY = "2026-11-18"
HASH = "0" * 64
GOOD_KEY = "uploads/" + "a" * 64 + ".csv"
BAD_KEY = "uploads/" + "b" * 64 + ".csv"
CONTRACTS = PROJECT_ROOT / "contracts" / "v2"
REQUEST = json.loads((PROJECT_ROOT / "contracts/examples/v2/run-request.example.json").read_text())
HOURS = 365 * 24


def _year_csv() -> bytes:
    rng = np.random.default_rng(3)
    index = pd.date_range("2025-01-01", periods=HOURS, freq="h")
    shape = 150 + 100 * np.sin((index.hour.to_numpy() - 13) / 24 * 2 * np.pi)
    lines = [PLD_CSV_HEADER]
    for position, moment in enumerate(index):
        for submarket in SUBMARKETS:
            price = shape[position] * rng.uniform(0.8, 1.2) + 60
            lines.append(f"{moment:%Y-%m-%dT%H:%M},{submarket},{price:.2f}")
    return ("\n".join(lines) + "\n").encode()


@pytest.fixture(scope="module")
def year_csv() -> bytes:
    return _year_csv()


@pytest.fixture(scope="module")
def solved(year_csv: bytes) -> Portfolio:
    return solve_portfolio(parse_pld(year_csv), hourly_battery_from_request(REQUEST))


@pytest.fixture
def aws(monkeypatch: pytest.MonkeyPatch, year_csv: bytes) -> Iterator[Any]:
    for name, value in {
        "AWS_ACCESS_KEY_ID": "test",
        "AWS_SECRET_ACCESS_KEY": "test",
        "AWS_DEFAULT_REGION": "eu-west-2",
        "TABLE_NAME": TABLE,
        "DATA_BUCKET": BUCKET,
    }.items():
        monkeypatch.setenv(name, value)
    monkeypatch.delenv("AWS_ENDPOINT_URL", raising=False)
    with mock_aws():
        handler._aws.cache_clear()
        dynamodb = boto3.client("dynamodb")
        dynamodb.create_table(
            TableName=TABLE,
            AttributeDefinitions=[{"AttributeName": "pk", "AttributeType": "S"}],
            KeySchema=[{"AttributeName": "pk", "KeyType": "HASH"}],
            BillingMode="PAY_PER_REQUEST",
        )
        s3 = boto3.client("s3")
        s3.create_bucket(
            Bucket=BUCKET, CreateBucketConfiguration={"LocationConstraint": "eu-west-2"}
        )
        s3.put_object(Bucket=BUCKET, Key=GOOD_KEY, Body=year_csv)
        s3.put_object(Bucket=BUCKET, Key=BAD_KEY, Body=b"timestamp,market_1\n")
        yield dynamodb
    handler._aws.cache_clear()


@pytest.fixture
def replay(monkeypatch: pytest.MonkeyPatch, solved: Portfolio) -> list[float | None]:
    """Answer ``solve_portfolio`` from the shared solve, reporting its progress."""
    limits: list[float | None] = []

    def fake(
        prices: pd.DataFrame,
        battery: Any,
        *,
        time_limit: float | None = None,
        on_case: Callable[[CaseProgress], None] | None = None,
    ) -> Portfolio:
        limits.append(time_limit)
        assert len(prices) == HOURS
        total = len(solved.results)
        if on_case is not None:
            for done, (submarket, case) in enumerate(solved.results):
                on_case(CaseProgress(done, total, submarket, case, float(done)))
        return solved

    monkeypatch.setattr(handler, "solve_portfolio", fake)
    return limits


def _queue(dynamodb: Any, status: str = "queued") -> None:
    """The items the API writes when it accepts a run: the run, its pointer, the quota."""
    items = [
        {
            "pk": {"S": f"run#{RUN_ID}"},
            "run_id": {"S": RUN_ID},
            "user_sub": {"S": SUB},
            "params_hash": {"S": HASH},
            "status": {"S": status},
            "created_at": {"S": f"{DAY}T09:30:58Z"},
        },
        {"pk": {"S": f"hash#{HASH}"}, "run_id": {"S": RUN_ID}},
        {"pk": {"S": f"quota#{SUB}#{DAY}"}, "used": {"N": "1"}},
        {"pk": {"S": f"global#{DAY}"}, "used": {"N": "1"}},
    ]
    for item in items:
        dynamodb.put_item(TableName=TABLE, Item=item)


def _message(key: str = GOOD_KEY, **request: Any) -> dict[str, Any]:
    return {
        "version": 2,
        "model_version": "pld-hourly-1",
        "run_id": RUN_ID,
        "params_hash": HASH,
        "user_sub": SUB,
        "request": {
            **REQUEST,
            "start": "2025-01-01",
            "end": "2025-12-31",
            "prices_key": key,
            **request,
        },
        "prices": {"source": "s3", "bucket": BUCKET, "key": key},
    }


def _event(message: dict[str, Any]) -> dict[str, Any]:
    return {"Records": [{"body": json.dumps(message)}]}


def _item(dynamodb: Any, pk: str) -> dict[str, Any] | None:
    item: dict[str, Any] | None = dynamodb.get_item(TableName=TABLE, Key={"pk": {"S": pk}}).get(
        "Item"
    )
    return item


def _used(dynamodb: Any) -> tuple[int, int]:
    quota, cap = _item(dynamodb, f"quota#{SUB}#{DAY}"), _item(dynamodb, f"global#{DAY}")
    assert quota is not None and cap is not None
    return int(quota["used"]["N"]), int(cap["used"]["N"])


def _validator(name: str) -> Draft202012Validator:
    schemas = {path.name: json.loads(path.read_text()) for path in CONTRACTS.glob("*.schema.json")}
    registry: Registry = Registry().with_resources(
        (schema["$id"], Resource.from_contents(schema)) for schema in schemas.values()
    )
    return Draft202012Validator(
        schemas[f"{name}.schema.json"], registry=registry, format_checker=FormatChecker()
    )


def test_a_solved_run_is_succeeded_with_its_result_and_plan(aws: Any) -> None:
    """The one test through the real eight programs."""
    _queue(aws)
    handler.handler(_event(_message()))

    run = _item(aws, f"run#{RUN_ID}")
    assert run is not None
    assert run["status"]["S"] == "succeeded"
    assert run["plan_csv_key"]["S"] == f"plans/{RUN_ID}.csv"
    assert {"started_at", "finished_at"} <= run.keys()
    assert ": " not in run["result_json"]["S"]  # compact
    assert len(run["result_json"]["S"].encode()) <= 300_000
    result = json.loads(run["result_json"]["S"])
    _validator("result").validate(result)
    assert result["horizon"]["hours"] == HOURS
    assert len(result["cases"]) == 8
    assert run["progress"]["M"]["done"]["BOOL"] is True
    assert run["progress"]["M"]["cases_done"]["N"] == "8"

    plan = boto3.client("s3").get_object(Bucket=BUCKET, Key=f"plans/{RUN_ID}.csv")
    assert len(plan["Body"].read().decode().splitlines()) == 1 + 8 * HOURS
    assert _used(aws) == (1, 1)


def test_a_redelivered_message_does_nothing(aws: Any, replay: list[float | None]) -> None:
    _queue(aws, status="running")
    handler.handler(_event(_message()))

    run = _item(aws, f"run#{RUN_ID}")
    assert run is not None and run["status"]["S"] == "running"
    assert replay == []
    assert "Contents" not in boto3.client("s3").list_objects_v2(Bucket=BUCKET, Prefix="plans/")


def test_a_rejected_price_file_fails_the_run_and_refunds_it_once(aws: Any) -> None:
    _queue(aws)
    handler.handler(_event(_message(key=BAD_KEY)))

    run = _item(aws, f"run#{RUN_ID}")
    assert run is not None and run["status"]["S"] == "failed"
    assert run["error"]["M"]["code"]["S"] == "prices_invalid"
    assert "finished_at" in run
    assert _used(aws) == (0, 0)
    assert _item(aws, f"hash#{HASH}") is None

    # The DLQ handler, or a redelivery, getting there second refunds nothing.
    handler.handler(_event(_message(key=BAD_KEY)))
    handler._fail({**_message(), "created_at": f"{DAY}T09:30:58Z"}, "solver_failed", "late")
    assert _used(aws) == (0, 0)
    run = _item(aws, f"run#{RUN_ID}")
    assert run is not None and run["error"]["M"]["code"]["S"] == "prices_invalid"


@pytest.mark.parametrize(
    "stale",
    [
        {"version": 1},
        {"model_version": "pld-hourly-0"},
    ],
    ids=["v1-message", "other-model"],
)
def test_a_stale_message_fails_the_run_and_refunds_it_once(
    aws: Any, replay: list[float | None], stale: dict[str, Any]
) -> None:
    _queue(aws)
    message = {**_message(), **stale}
    handler.handler(_event(message))

    run = _item(aws, f"run#{RUN_ID}")
    assert run is not None and run["status"]["S"] == "failed"
    assert run["error"]["M"]["code"]["S"] == "request_invalid"
    assert "earlier version" in run["error"]["M"]["message"]["S"]
    assert replay == []
    assert _used(aws) == (0, 0)
    assert _item(aws, f"hash#{HASH}") is None

    handler.handler(_event(message))
    assert _used(aws) == (0, 0)


#: A message of the retired contract, as a queue could still hold one.
V1_MESSAGE: dict[str, Any] = {
    "version": 1,
    "params_hash": "42b8449a308cbe544c9edefe454778d553e6dc1ea369a60b7a5dfabf51a1c774",
    "request": {
        "battery": {
            "max_charge_rate_mw": 2,
            "max_discharge_rate_mw": 2,
            "max_storage_volume_mwh": 4,
            "charging_loss_fraction": 0.05,
            "discharging_loss_fraction": 0.05,
            "lifetime_years": 10,
            "lifetime_cycles": 5000,
            "degradation_pct_per_cycle": 0.001,
        },
        "start": "2025-01-20",
        "end": "2025-01-22",
    },
    "prices": {"source": "bundled"},
}


def test_a_real_v1_message_is_refused_rather_than_solved(
    aws: Any, replay: list[float | None]
) -> None:
    _queue(aws)
    handler.handler(_event({**V1_MESSAGE, "run_id": RUN_ID, "user_sub": SUB}))

    run = _item(aws, f"run#{RUN_ID}")
    assert run is not None and run["status"]["S"] == "failed"
    assert replay == []
    assert _used(aws) == (0, 0)


def test_a_message_without_a_run_id_raises_for_the_dlq(aws: Any) -> None:
    with pytest.raises(ValueError, match="run_id"):
        handler.handler(_event({"version": 1}))


def test_a_conflicting_transaction_is_retried_not_taken_for_a_finished_run(
    aws: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    _queue(aws)
    client = handler._aws().dynamodb
    real, calls = client.transact_write_items, []

    def conflict_once(**kwargs: Any) -> Any:
        calls.append(1)
        if len(calls) == 1:
            raise ClientError(
                {
                    "Error": {"Code": "TransactionCanceledException", "Message": "conflict"},
                    "CancellationReasons": [
                        {"Code": "None"},
                        {"Code": "TransactionConflict"},
                        {"Code": "None"},
                    ],
                },
                "TransactWriteItems",
            )
        return real(**kwargs)

    monkeypatch.setattr(client, "transact_write_items", conflict_once)
    handler._fail({**_message(), "created_at": f"{DAY}T09:30:58Z"}, "solver_failed", "boom")

    assert len(calls) == 2
    run = _item(aws, f"run#{RUN_ID}")
    assert run is not None and run["status"]["S"] == "failed"
    assert _used(aws) == (0, 0)


@pytest.mark.parametrize(
    ("start", "end", "fragment"),
    [
        ("2024-12-31", "2025-12-31", "not all inside"),
        ("2025-02-01", "2026-01-31", "not all inside"),
        ("2025-01-01", "2025-06-30", "at least 365"),
    ],
    ids=["before", "after", "under-a-year"],
)
def test_dates_the_prices_cannot_serve_fail_the_run_as_request_invalid(
    aws: Any, replay: list[float | None], start: str, end: str, fragment: str
) -> None:
    _queue(aws)
    handler.handler(_event(_message(start=start, end=end)))

    run = _item(aws, f"run#{RUN_ID}")
    assert run is not None and run["status"]["S"] == "failed"
    assert run["error"]["M"]["code"]["S"] == "request_invalid"
    assert fragment in run["error"]["M"]["message"]["S"]
    assert replay == []
    assert _used(aws) == (0, 0)


def test_the_last_hour_of_the_prices_is_inside_them() -> None:
    """The check that once expected data up to 23:30 on the final day."""
    index = pd.date_range("2025-01-01", periods=HOURS, freq="h")
    prices = pd.DataFrame(100.0, index=index, columns=list(SUBMARKETS))
    window = handler._window(prices, {"start": "2025-01-01", "end": "2025-12-31"})
    assert len(window) == HOURS
    assert window.index[-1] == pd.Timestamp("2025-12-31 23:00")


def test_a_solve_out_of_time_fails_the_run_and_refunds_it(
    aws: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    def too_slow(*args: object, **kwargs: object) -> None:
        raise TimeoutError("the portfolio exceeded 1 s")

    monkeypatch.setattr(handler, "solve_portfolio", too_slow)
    _queue(aws)
    handler.handler(_event(_message()))

    run = _item(aws, f"run#{RUN_ID}")
    assert run is not None and run["status"]["S"] == "failed"
    assert run["error"]["M"]["code"]["S"] == "solver_failed"
    assert _used(aws) == (0, 0)


def test_an_unexpected_error_raises_and_leaves_the_run_to_the_dlq(
    aws: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    def broken(*args: object, **kwargs: object) -> None:
        raise RuntimeError("solver crashed")

    monkeypatch.setattr(handler, "solve_portfolio", broken)
    _queue(aws)
    with pytest.raises(RuntimeError, match="solver crashed"):
        handler.handler(_event(_message()))

    run = _item(aws, f"run#{RUN_ID}")
    assert run is not None and run["status"]["S"] == "running"
    assert _used(aws) == (1, 1)
    assert _item(aws, f"hash#{HASH}") is not None


def test_a_result_over_the_ceiling_raises_for_the_dlq(
    aws: Any, replay: list[float | None], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(handler, "MAX_RESULT_BYTES", 10)
    _queue(aws)
    with pytest.raises(RuntimeError, match="bytes"):
        handler.handler(_event(_message()))

    assert "Contents" not in boto3.client("s3").list_objects_v2(Bucket=BUCKET, Prefix="plans/")


def test_progress_is_written_once_per_program(aws: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    _queue(aws)
    writes: list[dict[str, Any]] = []
    monkeypatch.setattr(
        handler, "_update", lambda run_id, expression, **values: writes.append(values["progress"])
    )
    progress = handler._Progress(RUN_ID)
    for done, case in enumerate((BusinessCase.MERCHANT, BusinessCase.CONTRACTED)):
        progress(CaseProgress(done, 8, "SE", case, float(done)))

    assert [write["cases_done"] for write in writes] == [0, 1]
    assert [write["case"] for write in writes] == ["merchant", "contracted"]
    assert writes[1]["fraction"] == 1 / 8

    final = progress.final("2026-11-18T09:31:12Z", 9.0)
    assert (final["cases_done"], final["fraction"], final["done"]) == (8, 1, True)
    assert (final["submarket"], final["case"]) == (None, None)


class _Context:
    def get_remaining_time_in_millis(self) -> int:
        return 300_000


def test_the_solve_gets_the_invocation_time_left_less_the_finishing_margin(
    aws: Any, replay: list[float | None]
) -> None:
    _queue(aws)
    handler.handler(_event(_message()), _Context())

    (limit,) = replay
    assert limit is not None
    assert 300.0 - handler.FINISH_MARGIN - 30.0 <= limit <= 300.0 - handler.FINISH_MARGIN
    run = _item(aws, f"run#{RUN_ID}")
    assert run is not None and run["status"]["S"] == "succeeded"


def test_no_lambda_context_means_no_deadline() -> None:
    assert handler._deadline(None) is None


def test_the_bundled_prices_must_match_their_pin(
    tmp_path: Any, monkeypatch: pytest.MonkeyPatch, year_csv: bytes
) -> None:
    changed = tmp_path / "pld_hourly.csv"
    changed.write_bytes(year_csv)
    monkeypatch.setattr(handler, "PLD_CSV", changed)
    handler._bundled_prices.cache_clear()
    with pytest.raises(RuntimeError, match="pinned sha256"):
        handler._bundled_prices()
    handler._bundled_prices.cache_clear()


def test_the_bundled_prices_load_through_their_pin() -> None:
    handler._bundled_prices.cache_clear()
    prices = handler._bundled_prices()
    assert len(prices) == 16_080
    assert list(prices.columns) == list(SUBMARKETS)
    assert prices_sha256(handler.PLD_CSV.read_bytes()) == BUNDLED_PLD_SHA256


def test_elapsed_time_reaches_the_result(aws: Any, replay: list[float | None]) -> None:
    _queue(aws)
    before = time.perf_counter()
    handler.handler(_event(_message()))
    run = _item(aws, f"run#{RUN_ID}")
    assert run is not None
    seconds = json.loads(run["result_json"]["S"])["solve_seconds"]
    assert 0 <= seconds <= time.perf_counter() - before
