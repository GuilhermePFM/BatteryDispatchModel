"""The solver Lambda's handler (``services/solver/handler.py``) against moto's AWS.

Every run here is on two days of ``contracts/examples/prices-template.csv``
uploaded to the mocked bucket, so the dispatch itself takes well under a
second and the tests are about what happens around it: the conditional start,
the success record, the refund on a user error, and the raise on anything else.
"""

from __future__ import annotations

import dataclasses
import json
import time
from collections.abc import Iterator
from typing import Any

import boto3
import pytest
from botocore.exceptions import ClientError
from moto import mock_aws

import handler
from battery_plan.data_io.paths import PROJECT_ROOT
from battery_plan.dispatch import run_dispatch
from battery_plan.reporting import ProgressEvent

TABLE = "batteryplan"
BUCKET = "batteryplan-data"
RUN_ID = "01JD3X7Q8RZK5V2N4M6P9T0WYA"
SUB = "user-1"
DAY = "2026-11-18"
HASH = "0" * 64
TEMPLATE = PROJECT_ROOT / "contracts" / "examples" / "prices-template.csv"
REQUEST = json.loads((PROJECT_ROOT / "contracts/examples/run-request.example.json").read_text())


@pytest.fixture
def aws(monkeypatch: pytest.MonkeyPatch) -> Iterator[Any]:
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
        s3.put_object(Bucket=BUCKET, Key="uploads/good.csv", Body=TEMPLATE.read_bytes())
        s3.put_object(Bucket=BUCKET, Key="uploads/bad.csv", Body=b"timestamp,market_1\n")
        yield dynamodb
    handler._aws.cache_clear()


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


def _message(key: str = "uploads/good.csv", **request: Any) -> dict[str, Any]:
    return {
        "version": 1,
        "run_id": RUN_ID,
        "params_hash": HASH,
        "user_sub": SUB,
        "request": {**REQUEST, "start": "2018-01-01", "end": "2018-01-02", **request},
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


def test_a_solved_run_is_succeeded_with_its_result_and_plan(aws: Any) -> None:
    _queue(aws)
    handler.handler(_event(_message()))

    run = _item(aws, f"run#{RUN_ID}")
    assert run is not None
    assert run["status"]["S"] == "succeeded"
    assert run["plan_csv_key"]["S"] == f"plans/{RUN_ID}.csv"
    assert {"started_at", "finished_at"} <= run.keys()
    result = json.loads(run["result_json"]["S"])
    assert result["horizon"]["periods"] == 96
    assert ": " not in run["result_json"]["S"]  # compact
    assert run["progress"]["M"]["done"]["BOOL"] is True

    plan = boto3.client("s3").get_object(Bucket=BUCKET, Key=f"plans/{RUN_ID}.csv")
    assert len(plan["Body"].read().decode().splitlines()) == 1 + 96
    assert _used(aws) == (1, 1)


def test_a_redelivered_message_does_nothing(aws: Any) -> None:
    _queue(aws, status="running")
    handler.handler(_event(_message()))

    run = _item(aws, f"run#{RUN_ID}")
    assert run is not None and run["status"]["S"] == "running"
    assert "Contents" not in boto3.client("s3").list_objects_v2(Bucket=BUCKET, Prefix="plans/")


def test_a_rejected_price_file_fails_the_run_and_refunds_it_once(aws: Any) -> None:
    _queue(aws)
    handler.handler(_event(_message(key="uploads/bad.csv")))

    run = _item(aws, f"run#{RUN_ID}")
    assert run is not None and run["status"]["S"] == "failed"
    assert run["error"]["M"]["code"]["S"] == "prices_invalid"
    assert "finished_at" in run
    assert _used(aws) == (0, 0)
    assert _item(aws, f"hash#{HASH}") is None

    # The DLQ handler, or a redelivery, getting there second refunds nothing.
    handler.handler(_event(_message(key="uploads/bad.csv")))
    handler._fail({**_message(), "created_at": f"{DAY}T09:30:58Z"}, "solver_failed", "late")
    assert _used(aws) == (0, 0)
    run = _item(aws, f"run#{RUN_ID}")
    assert run is not None and run["error"]["M"]["code"]["S"] == "prices_invalid"


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


def test_dates_outside_an_upload_fail_the_run_as_request_invalid(aws: Any) -> None:
    _queue(aws)
    handler.handler(_event(_message(end="2018-02-01")))

    run = _item(aws, f"run#{RUN_ID}")
    assert run is not None and run["status"]["S"] == "failed"
    assert run["error"]["M"]["code"]["S"] == "request_invalid"
    assert _used(aws) == (0, 0)


def test_an_unexpected_error_raises_and_leaves_the_run_to_the_dlq(
    aws: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    def broken(*args: object, **kwargs: object) -> None:
        raise RuntimeError("solver crashed")

    monkeypatch.setattr(handler, "run_dispatch", broken)
    _queue(aws)
    with pytest.raises(RuntimeError, match="solver crashed"):
        handler.handler(_event(_message()))

    run = _item(aws, f"run#{RUN_ID}")
    assert run is not None and run["status"]["S"] == "running"
    assert _used(aws) == (1, 1)
    assert _item(aws, f"hash#{HASH}") is not None


def test_progress_is_written_at_once_on_a_new_pass_and_otherwise_every_few_seconds(
    aws: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    _queue(aws)
    writes: list[int] = []
    monkeypatch.setattr(
        handler,
        "_update",
        lambda run_id, expression, **values: writes.append(values["progress"]["pass_index"]),
    )
    progress = handler._Progress(RUN_ID)
    event = ProgressEvent("calibrate", 1, None, 20, 0.5, 0.25, 0.0, 1.0)
    for _ in range(1000):
        progress(event)
    assert writes == [1]  # the first event at once, the window-by-window ones held back

    progress(dataclasses.replace(event, pass_index=2))
    progress(dataclasses.replace(event, phase="recover", pass_index=2))
    assert writes == [1, 2, 2]

    monkeypatch.setattr(handler, "PROGRESS_INTERVAL", 0.0)
    progress(dataclasses.replace(event, phase="recover", pass_index=2))
    assert writes == [1, 2, 2, 2]


class _Context:
    def get_remaining_time_in_millis(self) -> int:
        return 300_000


def test_the_solve_gets_the_invocation_time_left_less_the_finishing_margin(
    aws: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    deadlines: list[float | None] = []

    def recording(*args: Any, deadline: float | None = None, **kwargs: Any) -> Any:
        deadlines.append(deadline)
        return run_dispatch(*args, deadline=deadline, **kwargs)

    monkeypatch.setattr(handler, "run_dispatch", recording)
    _queue(aws)
    before = time.perf_counter()
    handler.handler(_event(_message()), _Context())

    (deadline,) = deadlines
    assert deadline is not None
    expected = before + 300.0 - handler.FINISH_MARGIN
    assert expected <= deadline <= expected + 5.0
    run = _item(aws, f"run#{RUN_ID}")
    assert run is not None and run["status"]["S"] == "succeeded"
    assert json.loads(run["result_json"]["S"])["certificate"]["stopped_early"] is False


def test_no_lambda_context_means_no_deadline() -> None:
    assert handler._deadline(None) is None
