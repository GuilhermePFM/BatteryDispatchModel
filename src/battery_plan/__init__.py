"""Battery investment model for Brazil's hourly PLD market.

The package is split three ways:

* :mod:`battery_plan.data_io` — the bundled PLD, its loader and the upload check;
* :mod:`battery_plan.modelling` — the dispatch of one battery, per submarket and case;
* :mod:`battery_plan.contracts` and :mod:`battery_plan.result_v2` — the run request,
  its hash and the result the web reads.
"""

from battery_plan.data_io import SUBMARKETS, load_pld
from battery_plan.modelling import BusinessCase, HourlyBattery, solve_portfolio

__all__ = [
    "SUBMARKETS",
    "BusinessCase",
    "HourlyBattery",
    "load_pld",
    "solve_portfolio",
]
