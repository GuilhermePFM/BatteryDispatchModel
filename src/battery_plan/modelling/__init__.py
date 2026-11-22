"""Modelling: the dispatch problem of ``docs/model/model.md``.

The formulation lives in :mod:`~battery_plan.modelling.constraints` (§3 to
§4.7) over the variables declared in :mod:`~battery_plan.modelling.variables`,
is assembled and solved one window at a time by
:mod:`~battery_plan.modelling.window_problem`, and is applied to the horizon by
:mod:`~battery_plan.modelling.rolling_horizon` (§6); the output it produces is
described by :mod:`~battery_plan.modelling.plan`. The cycle budget's value, when
it binds, is found by the search layer in
:mod:`~battery_plan.modelling.cycle_value`.
"""

from battery_plan.modelling.cycle_value import (
    DEFAULT_SEARCH,
    SEARCHES,
    CalibratedPolicy,
    CycleOracle,
    DualBound,
    DualSearch,
    DualSearchResult,
    calibrate_cycle_value,
    search_named,
)
from battery_plan.modelling.parameters import ModelParameters, prorated_cycle_budget
from battery_plan.modelling.periods import SettlementPeriods, build_periods
from battery_plan.modelling.plan import build_plan, summarise
from battery_plan.modelling.policy import DispatchPolicy
from battery_plan.modelling.rolling_horizon import RollingPolicy
from battery_plan.modelling.variables import BatteryState
from battery_plan.modelling.window_problem import WindowSolution, solve_window

__all__ = [
    "DEFAULT_SEARCH",
    "SEARCHES",
    "BatteryState",
    "CalibratedPolicy",
    "CycleOracle",
    "DispatchPolicy",
    "DualBound",
    "DualSearch",
    "DualSearchResult",
    "ModelParameters",
    "RollingPolicy",
    "SettlementPeriods",
    "WindowSolution",
    "build_periods",
    "build_plan",
    "calibrate_cycle_value",
    "prorated_cycle_budget",
    "search_named",
    "solve_window",
    "summarise",
]
