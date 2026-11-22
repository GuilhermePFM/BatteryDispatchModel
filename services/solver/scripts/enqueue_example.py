"""Queue a run on the local stack the way the API does, and wait for the solver.

    docker compose up -d localstack solver
    cd services/solver/scripts
    uv run python enqueue_example.py                        # 3 days, bundled prices
    uv run python enqueue_example.py --start 2019-01-01 --end 2019-12-31
    uv run python enqueue_example.py --prices ../../../contracts/examples/prices-template.csv

It writes what ``POST /api/runs`` would (contracts/platform.md, "Submitting a
run"): the queued run, its cache pointer and one unit of the user's and the
site's daily quota, with an uploaded file put at ``uploads/<sha256>.csv``; then
it sends the job message and polls the run until it is finished, printing its
status, error or result size, the plan CSV's size, and the quota left used.
No request validation beyond the schema's own is done here: that is how a bad
file or out-of-range dates reach the solver, to be failed there.
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import sys
import time
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any

import boto3
from boto3.dynamodb.types import TypeSerializer

from battery_plan.contracts import BUNDLED_PRICES_SHA256, params_hash, prices_sha256

os.environ.setdefault("AWS_ENDPOINT_URL", "http://localhost:4566")
os.environ.setdefault("AWS_DEFAULT_REGION", "eu-west-2")
os.environ.setdefault("AWS_ACCESS_KEY_ID", "test")
os.environ.setdefault("AWS_SECRET_ACCESS_KEY", "test")
TABLE = os.environ.get("TABLE_NAME", "batteryplan")
BUCKET = os.environ.get("DATA_BUCKET", "batteryplan-data")
QUEUE = "batteryplan-jobs"
USER_SUB = "local-user"

_serialize = TypeSerializer().serialize

BATTERY = {
    "max_charge_rate_mw": 2,
    "max_discharge_rate_mw": 2,
    "max_storage_volume_mwh": 4,
    "charging_loss_fraction": 0.05,
    "discharging_loss_fraction": 0.05,
    "lifetime_years": 10,
    "lifetime_cycles": 5000,
    "degradation_pct_per_cycle": 0.001,
    "capex_gbp": 500000,
    "fixed_opex_gbp_per_year": 5000,
}


def main() -> int:
    args = _parser().parse_args()
    dynamodb, s3, sqs = boto3.client("dynamodb"), boto3.client("s3"), boto3.client("sqs")

    request: dict[str, Any] = {
        "battery": BATTERY,
        "start": args.start,
        "end": args.end,
    }
    if args.cycle_budget is not None:
        request["cycle_budget"] = args.cycle_budget
    if args.prices is None:
        digest, prices = BUNDLED_PRICES_SHA256, {"source": "bundled"}
    else:
        content = args.prices.read_bytes()
        digest = prices_sha256(content)
        request["prices_key"] = f"uploads/{digest}.csv"
        s3.put_object(Bucket=BUCKET, Key=request["prices_key"], Body=content)
        prices = {"source": "s3", "bucket": BUCKET, "key": request["prices_key"]}

    run_id, now = _ulid(), datetime.now(UTC)
    stamp, day = now.strftime("%Y-%m-%dT%H:%M:%SZ"), now.strftime("%Y-%m-%d")
    digest = params_hash(request, digest)
    run = {
        "pk": f"run#{run_id}",
        "version": 1,
        "run_id": run_id,
        "user_sub": USER_SUB,
        "params_hash": digest,
        "status": "queued",
        "request": request,
        "created_at": stamp,
        "updated_at": stamp,
        "expires_at": int((now + timedelta(days=7)).timestamp()),
    }
    expires = int((now + timedelta(days=2)).timestamp())
    dynamodb.transact_write_items(
        TransactItems=[
            {"Put": {"TableName": TABLE, "Item": _item(run)}},
            {
                "Put": {
                    "TableName": TABLE,
                    "Item": _item({"pk": f"hash#{digest}", "run_id": run_id}),
                }
            },
            *(
                {
                    "Update": {
                        "TableName": TABLE,
                        "Key": {"pk": {"S": pk}},
                        "UpdateExpression": "ADD used :one SET expires_at = :expires",
                        "ExpressionAttributeValues": {
                            ":one": {"N": "1"},
                            ":expires": {"N": str(expires)},
                        },
                    }
                }
                for pk in (f"quota#{USER_SUB}#{day}", f"global#{day}")
            ),
        ]
    )
    message = {
        "version": 1,
        "run_id": run_id,
        "params_hash": digest,
        "user_sub": USER_SUB,
        "request": request,
        "prices": prices,
    }
    queue_url = sqs.get_queue_url(QueueName=QUEUE)["QueueUrl"]
    sqs.send_message(QueueUrl=queue_url, MessageBody=json.dumps(message))
    print(f"queued {run_id}", file=sys.stderr)
    if args.no_wait:
        return 0

    started = time.monotonic()
    while True:
        item = dynamodb.get_item(TableName=TABLE, Key={"pk": {"S": f"run#{run_id}"}})["Item"]
        status = item["status"]["S"]
        if status in ("succeeded", "failed"):
            break
        if "progress" in item:
            fraction = float(item["progress"]["M"]["fraction"]["N"])
            print(f"  {status} {fraction:.0%}", file=sys.stderr)
        time.sleep(2)

    used = [
        dynamodb.get_item(TableName=TABLE, Key={"pk": {"S": pk}})["Item"]["used"]["N"]
        for pk in (f"quota#{USER_SUB}#{day}", f"global#{day}")
    ]
    print(
        f"{status} after {time.monotonic() - started:.0f} s; quota used {used[0]}, global {used[1]}"
    )
    if status == "failed":
        print(f"  error: {item['error']['M']['code']['S']}: {item['error']['M']['message']['S']}")
        return 1
    result = json.loads(item["result_json"]["S"])
    plan = s3.head_object(Bucket=BUCKET, Key=item["plan_csv_key"]["S"])
    print(
        f"  result_json {len(item['result_json']['S']) / 1024:.0f} KB, "
        f"profit £{result['headline']['profit_gbp']:,.0f}, "
        f"{result['certificate']['passes'] if result.get('certificate') else '?'} passes\n"
        f"  {item['plan_csv_key']['S']} {plan['ContentLength'] / 1024:.0f} KB"
    )
    return 0


def _item(values: dict[str, Any]) -> dict[str, Any]:
    return {
        key: _serialize(json.loads(json.dumps(value), parse_float=Decimal))
        for key, value in values.items()
    }


def _ulid() -> str:
    """A ULID: 48 bits of milliseconds and 80 random bits, in Crockford base32."""
    alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
    value = (int(time.time() * 1000) << 80) | secrets.randbits(80)
    return "".join(alphabet[(value >> shift) & 31] for shift in range(125, -1, -5))


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--start", default="2018-01-01")
    parser.add_argument("--end", default="2018-01-03")
    parser.add_argument("--cycle-budget", type=float)
    parser.add_argument("--prices", type=Path, help="a CSV to upload (default: bundled prices)")
    parser.add_argument("--no-wait", action="store_true", help="queue it and return")
    return parser


if __name__ == "__main__":
    raise SystemExit(main())
