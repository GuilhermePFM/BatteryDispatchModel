"""The eight programs of §6, their annual values, and the 24+0 backtest.

A battery sits in one of four submarkets under one of two business cases. The
submarkets do not couple, so solving each on its own and comparing is exact.

Two annual figures come out of each solution. The balanced year (§8.3) gives
each calendar month the same weight, because the data covers some months twice
and others once. The last twelve months are the sensitivity.

The perfect-foresight merchant value is a ceiling. :func:`backtest_day_ahead`
decides each day seeing only that day's prices, and the ratio of the two is the
capture factor of §8.
"""

from __future__ import annotations

import calendar
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from enum import StrEnum

import numpy as np
import pandas as pd
import pulp

from battery_plan.modelling.hourly import (
    CRCAP_LIMITS,
    ContractLimits,
    HourlyBattery,
    HourlySolution,
    HourlyState,
    solve_contracted,
    solve_hourly,
)

#: Days of each calendar month in the 365-day reference year of §8.3.
_REFERENCE_YEAR = 2025
DAYS_IN_MONTH = {month: calendar.monthrange(_REFERENCE_YEAR, month)[1] for month in range(1, 13)}


class BusinessCase(StrEnum):
    """The two separate cases of §1. They are compared and never added."""

    CONTRACTED = "contracted"
    MERCHANT = "merchant"


def balanced_year(daily: pd.Series, month_index: Mapping[int, float] | None = None) -> float:
    """§8.3: a year in which each calendar month carries its own weight.

    ``month_index`` optionally restates a value from a ``(year * 100 + month)``
    key to the base date, as ``I_base / I_month``. Without it the values stay
    nominal: the IPCA is a browser input (§8.1) and the solver carries none.
    """
    index = pd.DatetimeIndex(daily.index)
    values = daily
    if month_index is not None:
        keys = index.year * 100 + index.month
        missing = sorted(set(keys) - set(month_index))
        if missing:
            raise ValueError(f"no index for months {missing}")
        values = daily * [month_index[key] for key in keys]

    months = set(index.month)
    if months != set(DAYS_IN_MONTH):
        raise ValueError(f"a balanced year needs all 12 months, got {sorted(months)}")
    means = values.groupby(index.month).mean()
    return sum(days * float(means.loc[month]) for month, days in DAYS_IN_MONTH.items())


def last_twelve_months(daily: pd.Series) -> float:
    """The sum over the twelve months ending on the last day (§8.3's sensitivity)."""
    index = pd.DatetimeIndex(daily.index)
    return float(daily[index > index[-1] - pd.DateOffset(years=1)].sum())


@dataclass(frozen=True, slots=True)
class CaseResult:
    """One of the eight solutions, with its annual figures in BRL."""

    submarket: str
    case: BusinessCase
    solution: HourlySolution
    balanced_year_brl: float
    last_twelve_months_brl: float

    @property
    def physical_cycles(self) -> float:
        """Equivalent full cycles over the horizon (§4.6)."""
        return float(self.solution.cycles[-1])


@dataclass(frozen=True, slots=True)
class Portfolio:
    """The solved grid. Case C is absent when the battery cannot meet the contract."""

    results: Mapping[tuple[str, BusinessCase], CaseResult]
    contract_shortfalls: tuple[str, ...]
    below_minimum_power: bool

    def ranking(self) -> list[CaseResult]:
        """Submarkets from best to worst, by the merchant case (§6)."""
        merchant = [r for r in self.results.values() if r.case is BusinessCase.MERCHANT]
        return sorted(merchant, key=lambda result: result.balanced_year_brl, reverse=True)

    def regret(self) -> dict[str, float]:
        """BRL per year lost by building in each submarket instead of the best (§6)."""
        ranked = self.ranking()
        best = ranked[0].balanced_year_brl
        return {result.submarket: best - result.balanced_year_brl for result in ranked}


@dataclass(frozen=True, slots=True)
class CaseProgress:
    """The program about to be solved, and how many came before it."""

    cases_done: int
    cases_total: int
    submarket: str
    case: BusinessCase
    elapsed: float


def solve_case(
    prices: pd.Series,
    battery: HourlyBattery,
    case: BusinessCase,
    limits: ContractLimits = CRCAP_LIMITS,
    *,
    time_limit: float | None = None,
) -> HourlySolution:
    """One submarket under one case. The merchant case inherits no contract limit (§4.5)."""
    if case is BusinessCase.MERCHANT:
        return solve_hourly(prices, battery, time_limit=time_limit)
    return solve_contracted(prices, battery, limits, time_limit=time_limit)


def solve_portfolio(
    prices: pd.DataFrame,
    battery: HourlyBattery,
    limits: ContractLimits = CRCAP_LIMITS,
    *,
    time_limit: float | None = None,
    on_case: Callable[[CaseProgress], None] | None = None,
) -> Portfolio:
    """All submarkets by both cases, inside one ``time_limit`` when one is given.

    ``on_case`` hears about each program just before it is solved.
    """
    shortfalls = limits.sizing_shortfalls(battery)
    cases = [BusinessCase.MERCHANT]
    if not shortfalls:
        cases.append(BusinessCase.CONTRACTED)

    started = time.perf_counter()
    total = len(prices.columns) * len(cases)
    results: dict[tuple[str, BusinessCase], CaseResult] = {}
    for submarket in prices.columns:
        for case in cases:
            remaining = None
            if time_limit is not None:
                remaining = time_limit - (time.perf_counter() - started)
                if remaining <= 0:
                    raise TimeoutError(f"the portfolio exceeded {time_limit:g} s")
            if on_case is not None:
                elapsed = time.perf_counter() - started
                on_case(CaseProgress(len(results), total, str(submarket), case, elapsed))
            solution = solve_case(prices[submarket], battery, case, limits, time_limit=remaining)
            daily = solution.daily_value
            results[(str(submarket), case)] = CaseResult(
                submarket=str(submarket),
                case=case,
                solution=solution,
                balanced_year_brl=balanced_year(daily),
                last_twelve_months_brl=last_twelve_months(daily),
            )
    return Portfolio(
        results=results,
        contract_shortfalls=shortfalls,
        below_minimum_power=limits.below_minimum_power(battery),
    )


def backtest_day_ahead(prices: pd.Series, battery: HourlyBattery) -> HourlySolution:
    """The 24+0 merchant backtest: each day is decided with no view of the next.

    The state of charge and the cycle count carry across midnight. A day's
    program places no value on energy left in the store, so that is what the
    missing foresight costs.
    """
    started = time.perf_counter()
    solver = pulp.HiGHS(msg=False)
    days = pd.DatetimeIndex(prices.index).normalize()
    state = HourlyState()
    pieces: list[HourlySolution] = []
    for day in days.unique():
        solution = solve_hourly(prices[days == day], battery, state=state, solver=solver)
        pieces.append(solution)
        state = HourlyState(
            storage_mwh=float(solution.storage_mwh[-1]), cycles=float(solution.cycles[-1])
        )

    return HourlySolution(
        index=pd.DatetimeIndex(prices.index),
        prices=prices.to_numpy(dtype=float),
        charge_mw=_joined(pieces, "charge_mw"),
        discharge_mw=_joined(pieces, "discharge_mw"),
        storage_mwh=_joined(pieces, "storage_mwh"),
        cycles=_joined(pieces, "cycles"),
        discharge_efficiency=battery.discharge_efficiency,
        method="backtest-24+0",
        solve_seconds=time.perf_counter() - started,
    )


def _joined(pieces: list[HourlySolution], name: str) -> np.ndarray:
    return np.concatenate([getattr(piece, name) for piece in pieces])


@dataclass(frozen=True, slots=True)
class CaptureFactor:
    """Backtest value over the perfect-foresight value of the same battery and data."""

    submarket: str
    perfect_balanced_brl: float
    backtest_balanced_brl: float
    perfect_last_twelve_brl: float
    backtest_last_twelve_brl: float

    @property
    def balanced(self) -> float:
        """The capture factor ``phi`` of §8, on the balanced year."""
        return self.backtest_balanced_brl / self.perfect_balanced_brl

    @property
    def last_twelve_months(self) -> float:
        """The same ratio over the last twelve months."""
        return self.backtest_last_twelve_brl / self.perfect_last_twelve_brl


def capture_factor(
    prices: pd.Series, battery: HourlyBattery, *, perfect: HourlySolution | None = None
) -> CaptureFactor:
    """Measure ``phi`` for one submarket."""
    ceiling = perfect if perfect is not None else solve_hourly(prices, battery)
    backtest = backtest_day_ahead(prices, battery)
    return CaptureFactor(
        submarket=str(prices.name),
        perfect_balanced_brl=balanced_year(ceiling.daily_value),
        backtest_balanced_brl=balanced_year(backtest.daily_value),
        perfect_last_twelve_brl=last_twelve_months(ceiling.daily_value),
        backtest_last_twelve_brl=last_twelve_months(backtest.daily_value),
    )


__all__ = [
    "DAYS_IN_MONTH",
    "BusinessCase",
    "CaptureFactor",
    "CaseProgress",
    "CaseResult",
    "Portfolio",
    "backtest_day_ahead",
    "balanced_year",
    "capture_factor",
    "last_twelve_months",
    "solve_case",
    "solve_portfolio",
]
