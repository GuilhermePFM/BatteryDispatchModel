"""Re-run the measurements that docs/solve.md quotes for the hourly PLD model.

uv run python scripts/measure_pld_dispatch.py relaxation   # where the 12 h limit binds
uv run python scripts/measure_pld_dispatch.py milp         # worst-case MILP time
uv run python scripts/measure_pld_dispatch.py capture      # the 24+0 backtest
uv run python scripts/measure_pld_dispatch.py portfolio    # the 4x2 grid
"""

from __future__ import annotations

import argparse
import resource
import time
from dataclasses import replace

import pandas as pd

from battery_plan.data_io import SUBMARKETS, load_pld
from battery_plan.modelling.hourly import (
    CRCAP_LIMITS,
    ContractLimits,
    HourlyBattery,
    solve_contracted,
    solve_hourly,
)
from battery_plan.modelling.portfolio import capture_factor, solve_portfolio

DURATIONS = (4.0, 6.0, 8.0, 10.0, 12.0, 16.0, 24.0)
MILP_LIMIT_SECONDS = 600.0

#: One contracted solve's share of a Lambda run: four of them fit in its 600 s.
CASE_LIMIT_SECONDS = MILP_LIMIT_SECONDS / 4


def _peak_mb() -> float:
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024


def relaxation(prices: pd.DataFrame) -> None:
    """Days of the relaxed contracted plan that break the 12 h limit, by duration."""
    print("hours submarket seconds days_over_12h max_hours")
    for hours in DURATIONS:
        battery = HourlyBattery.sized(1.0, hours=hours)
        for submarket in SUBMARKETS:
            solution = solve_hourly(prices[submarket], battery, limits=CRCAP_LIMITS)
            injected = solution.injection_hours(battery.max_discharge_mw)
            over = int((injected > CRCAP_LIMITS.injection_hours_per_day).sum())
            print(
                f"{hours:5.0f} {submarket:>9} {solution.solve_seconds:7.2f} "
                f"{over:13d} {int(injected.max()):9d}",
                flush=True,
            )


def milp(prices: pd.DataFrame, submarkets: tuple[str, ...]) -> None:
    """The MILP path on real prices, each solve held to its share of a Lambda run.

    The 12 h limit does not bind on this data (see ``relaxation``), so the path is
    forced two ways: a tighter limit makes the lazy loop branch, and a binary on
    every day of the horizon is the largest program the formulation can pose.
    """
    print("mode limit_h hours submarket method rounds binary_days seconds value peak_mb")
    for submarket in submarkets:
        series = prices[submarket]
        every_day = frozenset(pd.DatetimeIndex(series.index).normalize().unique())
        for hours in (4.0, 12.0):
            battery = HourlyBattery.sized(1.0, hours=hours)
            started = time.perf_counter()
            try:
                full = solve_hourly(
                    series,
                    battery,
                    limits=CRCAP_LIMITS,
                    binary_days=every_day,
                    time_limit=CASE_LIMIT_SECONDS,
                )
                outcome = f"milp 0 {len(every_day)} {full.solve_seconds:.1f} {full.value:.2f}"
            except (TimeoutError, RuntimeError) as error:
                outcome = f"failed after {time.perf_counter() - started:.0f} s: {error}"
            print(f"full 12 {hours:.0f} {submarket} {outcome} {_peak_mb():.0f}", flush=True)

        for limit in (10, 8, 6):
            tight = replace(CRCAP_LIMITS, injection_hours_per_day=limit)
            for hours in (4.0, 8.0, 12.0):
                battery = HourlyBattery.sized(1.0, hours=hours)
                _timed("lazy", limit, hours, submarket, battery, series, tight)


def _timed(
    mode: str,
    limit: int,
    hours: float,
    submarket: str,
    battery: HourlyBattery,
    series: pd.Series,
    limits: ContractLimits,
) -> None:
    started = time.perf_counter()
    try:
        solved = solve_contracted(series, battery, limits, time_limit=CASE_LIMIT_SECONDS)
        outcome = (
            f"{solved.method} {solved.milp_rounds} {solved.binary_days} "
            f"{solved.solve_seconds:.1f} {solved.value:.2f}"
        )
    except (TimeoutError, RuntimeError) as error:
        outcome = f"failed after {time.perf_counter() - started:.0f} s: {error}"
    print(f"{mode} {limit} {hours:.0f} {submarket} {outcome} {_peak_mb():.0f}", flush=True)


def capture(prices: pd.DataFrame) -> None:
    """The 24+0 capture factor by submarket and duration."""
    print("hours submarket perfect_brl backtest_brl phi phi_last12")
    for hours in (2.0, 4.0, 6.0, 8.0):
        battery = HourlyBattery.sized(1.0, hours=hours)
        for submarket in SUBMARKETS:
            factor = capture_factor(prices[submarket].rename(submarket), battery)
            print(
                f"{hours:5.0f} {submarket:>9} {factor.perfect_balanced_brl:11.0f} "
                f"{factor.backtest_balanced_brl:12.0f} {factor.balanced:.4f} "
                f"{factor.last_twelve_months:.4f}",
                flush=True,
            )


def portfolio(prices: pd.DataFrame) -> None:
    """The eight programs of the default battery, in one timed run."""
    started = time.perf_counter()
    grid = solve_portfolio(prices, HourlyBattery.sized(1.0), time_limit=MILP_LIMIT_SECONDS)
    elapsed = time.perf_counter() - started
    for (submarket, case), result in grid.results.items():
        print(
            f"{submarket:>2} {case:<10} {result.solution.method:<13} "
            f"balanced={result.balanced_year_brl:10.0f} "
            f"last12={result.last_twelve_months_brl:10.0f} "
            f"cycles={result.physical_cycles:7.1f} seconds={result.solution.solve_seconds:.2f}"
        )
    print("ranking", [result.submarket for result in grid.ranking()])
    print(f"total {elapsed:.1f} s, peak {_peak_mb():.0f} MB")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("measurement", choices=("relaxation", "milp", "capture", "portfolio"))
    parser.add_argument("--submarkets", nargs="+", choices=SUBMARKETS, default=list(SUBMARKETS))
    arguments = parser.parse_args()
    measurement = arguments.measurement
    prices = load_pld()
    if measurement == "milp":
        milp(prices, tuple(arguments.submarkets))
        return
    {"relaxation": relaxation, "capture": capture, "portfolio": portfolio}[measurement](prices)


if __name__ == "__main__":
    main()
