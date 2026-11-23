"""Modelling: the dispatch problem of ``docs/model/model.md``.

:mod:`~battery_plan.modelling.hourly` solves one battery in one submarket as one
program over the whole horizon (§2 to §6), with the capacity contract's limits
in the contracted case. :mod:`~battery_plan.modelling.portfolio` runs it across
the submarkets and business cases, and annualises the result (§6, §8.3).
"""

from battery_plan.modelling.hourly import (
    CRCAP_LIMITS,
    ContractLimits,
    HourlyBattery,
    HourlySolution,
    solve_contracted,
    solve_hourly,
)
from battery_plan.modelling.portfolio import (
    BusinessCase,
    CaseResult,
    Portfolio,
    solve_portfolio,
)

__all__ = [
    "CRCAP_LIMITS",
    "BusinessCase",
    "CaseResult",
    "ContractLimits",
    "HourlyBattery",
    "HourlySolution",
    "Portfolio",
    "solve_contracted",
    "solve_hourly",
    "solve_portfolio",
]
