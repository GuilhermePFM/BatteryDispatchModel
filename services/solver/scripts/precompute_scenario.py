"""Write the site's precomputed scenario: Attachment 1 over all of 2018-2020.

    uv run python services/solver/scripts/precompute_scenario.py

The full three-year horizon is longer than a web request may ask for (365
days), so the site ships it as a static file instead,
``web/public/scenarios/full-2018-2020.json``: a run-record with status
``succeeded`` and the ``result`` object inline, as ``GET /api/runs/{run_id}``
would return it. The run is the web's own — cutting planes, one committed day
and one day of lookahead — and takes 10-15 minutes.

The record is validated against ``contracts/run-record.schema.json`` before it
is written. The schema requires ``plan_csv_key`` on a succeeded run, but this
run's plan is not in any bucket, so the key is the placeholder
:data:`NO_PLAN_CSV`, and the record has no ``plan_csv_url``: the page should
offer no download for it.
"""

from __future__ import annotations

import dataclasses
import json
import sys
from datetime import UTC, datetime
from typing import Any

from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource

from battery_plan.analysis import build_result_payload
from battery_plan.contracts import (
    BUNDLED_PRICES_SHA256,
    config_from_request,
    params_hash,
    spec_from_request,
)
from battery_plan.data_io import load_market_prices
from battery_plan.data_io.paths import PROJECT_ROOT
from battery_plan.dispatch import run_dispatch
from battery_plan.reporting import ProgressEvent

CONTRACTS = PROJECT_ROOT / "contracts"
OUT = PROJECT_ROOT / "web" / "public" / "scenarios" / "full-2018-2020.json"

RUN_ID = "full-2018-2020"
USER_SUB = "precomputed"
#: Stands in for the plan CSV's S3 key, which the schema requires and this run lacks.
NO_PLAN_CSV = "precomputed/no-plan-csv"

#: Attachment 1 as given, over the whole of the bundled data.
REQUEST: dict[str, Any] = {
    "battery": {
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
    },
    "start": "2018-01-01",
    "end": "2020-12-31",
    "commit_days": 1,
    "lookahead_days": 1,
}


def main() -> int:
    started_at = _now()
    events: list[ProgressEvent] = []
    spec = spec_from_request(REQUEST)
    run = run_dispatch(spec, load_market_prices(), config_from_request(REQUEST), events.append)
    result = build_result_payload(run.plan, spec, run.params, run.search)
    finished_at = _now()

    record = {
        "version": 1,
        "run_id": RUN_ID,
        "user_sub": USER_SUB,
        "params_hash": params_hash(REQUEST, BUNDLED_PRICES_SHA256),
        "status": "succeeded",
        "request": REQUEST,
        "created_at": started_at,
        "updated_at": finished_at,
        "started_at": started_at,
        "finished_at": finished_at,
        "progress": {**dataclasses.asdict(events[-1]), "updated_at": finished_at},
        "result": result,
        "plan_csv_key": NO_PLAN_CSV,
    }
    _validator().validate(record)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(record, separators=(",", ":"), allow_nan=False))
    print(f"-> {OUT}  ({OUT.stat().st_size / 1024:.0f} KB, {run.elapsed:.0f} s)", file=sys.stderr)
    return 0


def _validator() -> Draft202012Validator:
    schemas = [json.loads(path.read_text()) for path in CONTRACTS.glob("*.schema.json")]
    registry: Registry = Registry().with_resources(
        (schema["$id"], Resource.from_contents(schema)) for schema in schemas
    )
    record = next(schema for schema in schemas if schema["$id"].endswith("/run-record.schema.json"))
    return Draft202012Validator(record, registry=registry, format_checker=FormatChecker())


def _now() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


if __name__ == "__main__":
    raise SystemExit(main())
