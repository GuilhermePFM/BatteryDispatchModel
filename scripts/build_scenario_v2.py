"""Write web/public/scenarios/pld-2025-2026.json, the dashboard's precomputed run.

    uv run python scripts/build_scenario_v2.py

A 30 MW, 4 h battery with the §2 defaults, over every day of the bundled PLD, in
the shape of the v2 result schema.
"""

from __future__ import annotations

import json
import math
import time
from pathlib import Path
from typing import Any

from battery_plan.contracts import hourly_battery_from_request
from battery_plan.data_io import load_pld
from battery_plan.modelling.portfolio import solve_portfolio
from battery_plan.result_v2 import MAX_RESULT_BYTES, build_result

OUTPUT = Path(__file__).resolve().parents[1] / "web" / "public" / "scenarios" / "pld-2025-2026.json"

_ONE_WAY = math.sqrt(0.85)
_VOLUME = 4 * 30 / _ONE_WAY

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
    "start": "2025-01-20",
    "end": "2026-11-20",
}


def main() -> int:
    prices = load_pld().loc[REQUEST["start"] : f"{REQUEST['end']} 23:00"]
    battery = hourly_battery_from_request(REQUEST)
    started = time.perf_counter()
    portfolio = solve_portfolio(prices, battery)
    result = build_result(portfolio, battery, REQUEST, time.perf_counter() - started)
    # Machine-dependent, and the file should only change when the code does.
    result["solve_seconds"] = 0.0
    for case in result["cases"]:
        case["solve_seconds"] = 0.0
    body = json.dumps(result, separators=(",", ":"), allow_nan=False)
    size = len(body.encode())
    if size > MAX_RESULT_BYTES:
        raise SystemExit(f"{size} bytes is over the {MAX_RESULT_BYTES} limit")
    OUTPUT.write_text(body + "\n")
    print(f"{size} bytes -> {OUTPUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
