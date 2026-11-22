"""Write the examples under contracts/examples/ from a real run.

    uv run python scripts/contract_examples.py

Everything in that directory is an output of this script, so the examples
cannot describe a payload the code no longer produces:

* ``prices-template.csv`` — January 2018 of Attachment 2 in the upload format,
  to the penny, read back through :func:`battery_plan.data_io.load_market_prices_csv` before
  it is kept. January is away from the spring clock change, whose repeated
  half hours the upload format does not allow;
* ``run-request.example.json`` — three days on the bundled prices;
* ``result.example.json`` — what that request solves to, through
  :func:`battery_plan.dispatch.run_dispatch` and
  :func:`battery_plan.analysis.build_result_payload`;
* ``job-message.example.json`` and ``run-record.example.json`` — the same run
  as the API queues it and as the solver finishes it;
* ``params-hash.json`` — the test vectors for the params hash of
  ``contracts/README.md``, one on the bundled prices and one on an upload.

``tests/test_contracts.py`` validates each against its schema.
"""

from __future__ import annotations

import dataclasses
import json
from pathlib import Path
from typing import Any

from battery_plan.analysis import build_result_payload
from battery_plan.contracts import (
    BUNDLED_PRICES_SHA256,
    canonical_json,
    config_from_request,
    params_hash,
    prices_sha256,
    spec_from_request,
)
from battery_plan.data_io import load_market_prices, load_market_prices_csv, write_market_prices_csv
from battery_plan.data_models import MarketPrices
from battery_plan.dispatch import run_dispatch
from battery_plan.reporting import ProgressEvent

EXAMPLES = Path(__file__).resolve().parents[1] / "contracts" / "examples"

#: Fixed so the examples only change when the code does.
RUN_ID = "01JD3X7Q8RZK5V2N4M6P9T0WYA"
USER_SUB = "3f1c9a2e-7b4d-4e8a-9c61-2d5f0b8e7a43"

#: Attachment 1 as given, over the first three days of the data.
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
    "end": "2018-01-03",
}

#: A second request for the hash vectors, exercising what the first does not:
#: an upload's ``prices_key`` (added by :func:`main`: ``uploads/<sha256>.csv``,
#: the only shape the API accepts), a fractional budget, and a number that
#: Python and Go print differently by default (5e-06 against 0.000005).
UPLOAD_REQUEST: dict[str, Any] = {
    **REQUEST,
    "battery": {**REQUEST["battery"], "degradation_pct_per_cycle": 0.000005},
    "cycle_budget": 4.5,
    "start": "2018-01-08",
    "end": "2018-01-14",
}


def main() -> int:
    template = EXAMPLES / "prices-template.csv"
    prices = load_market_prices()
    january = prices.between("2018-01-01", "2018-01-31 23:30")
    # Quoted in pence; the spreadsheet stores some as 52.144999999999996.
    january = MarketPrices(market_1=january.market_1.round(2), market_2=january.market_2.round(2))
    write_market_prices_csv(january, template)
    load_market_prices_csv(template)

    events: list[ProgressEvent] = []
    spec = spec_from_request(REQUEST)
    run = run_dispatch(spec, prices, config_from_request(REQUEST), events.append)
    result = build_result_payload(run.plan, spec, run.params, run.search)
    digest = params_hash(REQUEST, BUNDLED_PRICES_SHA256)

    progress = {**dataclasses.asdict(events[-1]), "updated_at": "2026-11-18T09:31:12Z"}
    _write("run-request.example.json", REQUEST)
    _write("result.example.json", result)
    _write(
        "job-message.example.json",
        {
            "version": 1,
            "run_id": RUN_ID,
            "params_hash": digest,
            "user_sub": USER_SUB,
            "request": REQUEST,
            "prices": {"source": "bundled"},
        },
    )
    _write(
        "run-record.example.json",
        {
            "version": 1,
            "run_id": RUN_ID,
            "user_sub": USER_SUB,
            "params_hash": digest,
            "status": "succeeded",
            "request": REQUEST,
            "created_at": "2026-11-18T09:30:58Z",
            "updated_at": "2026-11-18T09:31:12Z",
            "started_at": "2026-11-18T09:31:01Z",
            "finished_at": "2026-11-18T09:31:12Z",
            "progress": progress,
            "result": result,
            "plan_csv_key": f"plans/{RUN_ID}.csv",
        },
    )
    template_digest = prices_sha256(template.read_bytes())
    upload_request = {**UPLOAD_REQUEST, "prices_key": f"uploads/{template_digest}.csv"}
    _write(
        "params-hash.json",
        {
            "vectors": [
                _vector("bundled prices", REQUEST, BUNDLED_PRICES_SHA256),
                _vector(
                    "uploaded prices: prices_key is left out, the file's sha256 stands in",
                    upload_request,
                    template_digest,
                ),
            ]
        },
    )
    print(f"-> {EXAMPLES}")
    return 0


def _vector(name: str, request: dict[str, Any], prices_digest: str) -> dict[str, Any]:
    """One test vector, with the canonical string spelled out for a reader to diff against."""
    body = {key: value for key, value in request.items() if key != "prices_key"}
    return {
        "name": name,
        "request": request,
        "prices_sha256": prices_digest,
        "canonical": canonical_json({"prices_sha256": prices_digest, "request": body}),
        "params_hash": params_hash(request, prices_digest),
    }


def _write(name: str, document: object) -> None:
    (EXAMPLES / name).write_text(json.dumps(document, indent=2, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    raise SystemExit(main())
