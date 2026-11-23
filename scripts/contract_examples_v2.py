"""Write the examples under contracts/examples/v2/ from a real run.

    uv run python scripts/contract_examples_v2.py

Everything in that directory is an output of this script:

* ``run-request.example.json`` — a 30 MW, 4 h battery over the bundled PLD's
  first full calendar year window;
* ``result.example.json`` — what that request solves to;
* ``job-message.example.json`` — the same run as the API queues it;
* ``run-record.example.json`` — the run while it is solving. The succeeded
  record is this plus the result, which ``tests/test_contracts_v2.py`` builds,
  so the result is not stored twice;
* ``params-hash.json`` — the test vectors of the v2 params hash, one on the
  bundled prices and one on an upload.
"""

from __future__ import annotations

import json
import math
import time
from pathlib import Path
from typing import Any

from battery_plan.contracts import (
    BUNDLED_PLD_SHA256,
    CONTRACT_VERSION,
    MODEL_VERSION,
    canonical_json,
    hourly_battery_from_request,
    params_hash,
)
from battery_plan.data_io import load_pld
from battery_plan.modelling.portfolio import solve_portfolio
from battery_plan.result_v2 import build_result

EXAMPLES = Path(__file__).resolve().parents[1] / "contracts" / "examples" / "v2"

#: Fixed so the examples only change when the code does.
RUN_ID = "01JD3X7Q8RZK5V2N4M6P9T0WYA"
USER_SUB = "3f1c9a2e-7b4d-4e8a-9c61-2d5f0b8e7a43"

_ONE_WAY = math.sqrt(0.85)
_VOLUME = 4 * 30 / _ONE_WAY

#: The §2 defaults at the auction's minimum power.
REQUEST: dict[str, Any] = {
    "battery": {
        "power_mw": 30,
        "volume_mwh": _VOLUME,
        "max_charge_mw": 30,
        "max_discharge_mw": 30 / _ONE_WAY,
        "charge_efficiency": _ONE_WAY,
        "discharge_efficiency": _ONE_WAY,
        "degradation_pct_per_cycle": 0.001,
    },
    "start": "2025-02-01",
    "end": "2026-01-31",
}

#: A second request for the hash vectors: an upload's key, a fractional budget,
#: and a number that Python and Go print differently by default.
UPLOAD_DIGEST = "ab" * 32
UPLOAD_REQUEST: dict[str, Any] = {
    **REQUEST,
    "battery": {**REQUEST["battery"], "degradation_pct_per_cycle": 0.000005},
    "cycle_budget": 4.5,
    "prices_key": f"uploads/{UPLOAD_DIGEST}.csv",
}


def main() -> int:
    EXAMPLES.mkdir(parents=True, exist_ok=True)
    prices = load_pld().loc[REQUEST["start"] : f"{REQUEST['end']} 23:00"]
    battery = hourly_battery_from_request(REQUEST)
    started = time.perf_counter()
    portfolio = solve_portfolio(prices, battery)
    result = build_result(portfolio, battery, REQUEST, time.perf_counter() - started)
    # Machine-dependent, and the example should only change when the code does.
    result["solve_seconds"] = 0.0
    for case in result["cases"]:
        case["solve_seconds"] = 0.0
    digest = params_hash(REQUEST, BUNDLED_PLD_SHA256)

    _write("run-request.example.json", REQUEST)
    _write("result.example.json", result)
    _write(
        "job-message.example.json",
        {
            "version": CONTRACT_VERSION,
            "model_version": MODEL_VERSION,
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
            "version": CONTRACT_VERSION,
            "run_id": RUN_ID,
            "user_sub": USER_SUB,
            "params_hash": digest,
            "status": "running",
            "request": REQUEST,
            "created_at": "2026-11-22T09:30:58Z",
            "updated_at": "2026-11-22T09:31:04Z",
            "started_at": "2026-11-22T09:31:01Z",
            "progress": {
                "phase": "solving",
                "cases_done": 3,
                "cases_total": 8,
                "submarket": "S",
                "case": "contracted",
                "fraction": 0.375,
                "elapsed": 3.1,
                "done": False,
                "updated_at": "2026-11-22T09:31:04Z",
            },
        },
    )
    _write(
        "params-hash.json",
        {
            "model_version": MODEL_VERSION,
            "vectors": [
                _vector("bundled prices", REQUEST, BUNDLED_PLD_SHA256),
                _vector(
                    "uploaded prices: prices_key is left out, the file's sha256 stands in",
                    UPLOAD_REQUEST,
                    UPLOAD_DIGEST,
                ),
            ],
        },
    )
    print(f"-> {EXAMPLES}")
    return 0


def _vector(name: str, request: dict[str, Any], prices_digest: str) -> dict[str, Any]:
    """One test vector, with the canonical string spelled out for a reader to diff against."""
    body = {key: value for key, value in request.items() if key != "prices_key"}
    canonical = canonical_json(
        {"model_version": MODEL_VERSION, "prices_sha256": prices_digest, "request": body}
    )
    return {
        "name": name,
        "request": request,
        "prices_sha256": prices_digest,
        "canonical": canonical,
        "params_hash": params_hash(request, prices_digest),
    }


def _write(name: str, document: object) -> None:
    (EXAMPLES / name).write_text(json.dumps(document, indent=1, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    raise SystemExit(main())
