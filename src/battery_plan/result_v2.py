"""The v2 result: aggregates for every solved case, the detail of one, and the plan CSV.

A DynamoDB item holds 400 KB, so the eight hourly plans cannot travel in the
result. Each case keeps what the investment layer needs, per calendar month, and
only the merchant case of the top-ranked submarket keeps its series. All eight
plans go to the CSV in S3.

The values stay nominal. The IPCA is a browser input (§8.1), so the monthly
blocks are what lets the browser restate them without another solve.
"""

from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd

from battery_plan.contracts import CONTRACT_VERSION, MODEL_VERSION
from battery_plan.modelling.hourly import (
    CRCAP_LIMITS,
    HOURLY_DT,
    HOURS_PER_DAY,
    INJECTION_TOLERANCE,
    ContractLimits,
    HourlyBattery,
    HourlySolution,
)
from battery_plan.modelling.portfolio import BusinessCase, CaseResult, Portfolio, balanced_year

#: The ceiling of ``contracts/v2/result.schema.json``, as compact JSON.
MAX_RESULT_BYTES = 300_000

#: Days in the hour-by-hour view of the detail case.
_WEEK_DAYS = 7

PLAN_COLUMNS = (
    "hora",
    "submercado",
    "caso",
    "pld_brl_mwh",
    "charge_mw",
    "discharge_mw",
    "storage_mwh",
)


def build_result(
    portfolio: Portfolio,
    battery: HourlyBattery,
    request: dict[str, Any],
    solve_seconds: float,
    limits: ContractLimits = CRCAP_LIMITS,
) -> dict[str, Any]:
    """The payload of ``contracts/v2/result.schema.json``, as plain JSON types."""
    ranked = portfolio.ranking()
    regret = portfolio.regret()
    best = ranked[0]
    index = best.solution.index
    return {
        "version": CONTRACT_VERSION,
        "model_version": MODEL_VERSION,
        "horizon": {
            "start": request["start"],
            "end": request["end"],
            "days": len(index) // HOURS_PER_DAY,
            "hours": len(index),
        },
        "battery": _battery(battery, request, limits),
        "eligibility": {
            "contract_eligible": not portfolio.contract_shortfalls,
            "contract_shortfalls": list(portfolio.contract_shortfalls),
            "below_minimum_power": portfolio.below_minimum_power,
            "minimum_power_mw": limits.minimum_power_mw,
        },
        "ranking": [
            {
                "rank": position,
                "submarket": result.submarket,
                "balanced_year_brl": result.balanced_year_brl,
                "last_twelve_months_brl": result.last_twelve_months_brl,
                # The best submarket's own difference is exactly zero.
                "regret_brl_per_year": max(regret[result.submarket], 0.0),
            }
            for position, result in enumerate(ranked, start=1)
        ],
        "cases": [_case(result, battery) for result in _ordered(portfolio)],
        "detail": _detail(best, battery),
        "solve_seconds": solve_seconds,
    }


def plan_csv(portfolio: Portfolio) -> bytes:
    """Every solved plan, one row per hour, submarket and case."""
    frames = [
        pd.DataFrame(
            {
                "hora": result.solution.index.strftime("%Y-%m-%dT%H:%M"),
                "submercado": result.submarket,
                "caso": result.case.value,
                "pld_brl_mwh": result.solution.prices,
                "charge_mw": result.solution.charge_mw,
                "discharge_mw": result.solution.discharge_mw,
                "storage_mwh": result.solution.storage_mwh,
            },
            columns=list(PLAN_COLUMNS),
        )
        for result in _ordered(portfolio)
    ]
    text: str = pd.concat(frames).to_csv(index=False, float_format="%.4f", lineterminator="\n")
    return text.encode()


def _ordered(portfolio: Portfolio) -> list[CaseResult]:
    """The cases in the prices' submarket order, merchant before contracted."""
    return list(portfolio.results.values())


def _battery(
    battery: HourlyBattery, request: dict[str, Any], limits: ContractLimits
) -> dict[str, Any]:
    delivered = battery.discharge_efficiency * battery.volume_mwh
    return {
        "power_mw": battery.power_mw,
        "volume_mwh": battery.volume_mwh,
        "max_charge_mw": battery.max_charge_mw,
        "max_discharge_mw": battery.max_discharge_mw,
        "charge_efficiency": battery.charge_efficiency,
        "discharge_efficiency": battery.discharge_efficiency,
        "round_trip_efficiency": battery.round_trip_efficiency,
        "degradation_pct_per_cycle": float(request["battery"]["degradation_pct_per_cycle"]),
        "duration_hours": delivered / battery.power_mw,
        "contract_cycles_per_physical": limits.contract_cycles_per_physical(battery),
        "cycle_budget": battery.cycle_budget,
    }


def _case(result: CaseResult, battery: HourlyBattery) -> dict[str, Any]:
    solution = result.solution
    hours = solution.injection_hours(battery.max_discharge_mw)
    return {
        "submarket": result.submarket,
        "case": result.case.value,
        "value_brl": solution.value,
        "balanced_year_brl": result.balanced_year_brl,
        "last_twelve_months_brl": result.last_twelve_months_brl,
        "physical_cycles": result.physical_cycles,
        "cycles_per_year": max(balanced_year(_daily_cycles(solution)), 0.0),
        "max_injection_hours": int(hours.max()),
        "method": solution.method,
        "binary_days": solution.binary_days,
        "solve_seconds": solution.solve_seconds,
        "monthly": _monthly(solution, battery),
    }


def _daily_cycles(solution: HourlySolution) -> pd.Series:
    """Physical cycles completed on each day."""
    ends = pd.Series(solution.cycles, index=solution.index).groupby(solution.index.normalize())
    return ends.last().diff().fillna(ends.last().iloc[0])


def _monthly(solution: HourlySolution, battery: HourlyBattery) -> dict[str, list[Any]]:
    """The inputs of §8.3 and of the CRCAP 8.1 reimbursement, per calendar month."""
    index = solution.index
    injecting = solution.discharge_mw > INJECTION_TOLERANCE * battery.max_discharge_mw
    starts = injecting & ~np.concatenate(([False], injecting[:-1]))
    frame = pd.DataFrame(
        {
            "value_brl": solution.hourly_value,
            "charge_mwh": solution.charge_mw * HOURLY_DT,
            "injected_mwh": solution.discharge_efficiency * solution.discharge_mw * HOURLY_DT,
            "charge_cost_brl": solution.prices * solution.charge_mw * HOURLY_DT,
            "storage_end_mwh": solution.storage_mwh,
            "injections": starts.astype(int),
        },
        index=index,
    )
    months = frame.groupby(index.to_period("M"))
    summed = months[["value_brl", "charge_mwh", "injected_mwh", "charge_cost_brl"]].sum()
    days = pd.Series(1, index=index.normalize().unique())
    day_counts = days.groupby(pd.DatetimeIndex(days.index).to_period("M")).sum()
    return {
        "month": [str(period) for period in summed.index],
        "days": [int(count) for count in day_counts],
        "value_brl": _rounded(summed["value_brl"], 4),
        "charge_mwh": _rounded(summed["charge_mwh"], 6),
        "injected_mwh": _rounded(summed["injected_mwh"], 6),
        "charge_cost_brl": _rounded(summed["charge_cost_brl"], 4),
        "storage_end_mwh": _rounded(months["storage_end_mwh"].last(), 6),
        "injections": [int(count) for count in months["injections"].sum()],
    }


def _detail(result: CaseResult, battery: HourlyBattery) -> dict[str, Any]:
    solution = result.solution
    index = solution.index
    hourly = pd.DataFrame(
        {
            "price": solution.prices,
            "charge_mw": solution.charge_mw,
            "discharge_mw": solution.discharge_mw,
            "storage_mwh": solution.storage_mwh,
        },
        index=index,
    )
    day_of = index.normalize()
    days = pd.DatetimeIndex(day_of.unique())
    price = hourly["price"].groupby(day_of)
    value = solution.daily_value
    profile = hourly.groupby(index.hour).mean()
    net = solution.discharge_efficiency * solution.discharge_mw - solution.charge_mw
    permille = np.rint(1000 * net / battery.power_mw).astype(int).reshape(-1, HOURS_PER_DAY)

    first = _median_week(value)
    week = hourly.iloc[first * HOURS_PER_DAY : (first + _WEEK_DAYS) * HOURS_PER_DAY]
    dates = [f"{day:%Y-%m-%d}" for day in days]
    return {
        "submarket": result.submarket,
        "case": BusinessCase(result.case).value,
        "daily": {
            "date": dates,
            "value_brl": _rounded(value, 2),
            "cycles": _rounded(_daily_cycles(solution), 4),
            "price_mean": _rounded(price.mean(), 2),
            "price_min": _rounded(price.min(), 2),
            "price_max": _rounded(price.max(), 2),
            "storage_end_mwh": _rounded(hourly["storage_mwh"].groupby(day_of).last(), 3),
        },
        "profile": {
            "hour": [int(hour) for hour in profile.index],
            "price": _rounded(profile["price"], 2),
            "charge_mw": _rounded(profile["charge_mw"], 4),
            "discharge_mw": _rounded(profile["discharge_mw"], 4),
        },
        "week": {
            "hora": [f"{moment:%Y-%m-%dT%H:%M}" for moment in week.index],
            "price": _rounded(week["price"], 2),
            "charge_mw": _rounded(week["charge_mw"], 4),
            "discharge_mw": _rounded(week["discharge_mw"], 4),
            "storage_mwh": _rounded(week["storage_mwh"], 4),
        },
        "net_power": {"date": dates, "permille": permille.tolist()},
    }


def _median_week(daily: pd.Series) -> int:
    """Position of the first day of the seven-day run with the median value."""
    totals = daily.rolling(_WEEK_DAYS).sum().dropna().to_numpy()
    return int(np.argsort(totals)[len(totals) // 2])


def _rounded(values: pd.Series, decimals: int) -> list[float]:
    """Rounded for the wire; adding zero turns a ``-0.0`` into ``0.0``."""
    return [float(value) for value in values.round(decimals).to_numpy() + 0.0]
