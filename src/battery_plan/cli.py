"""Command line entry point: look at the bundled PLD, or solve a battery on it.

``battery-plan inputs`` prints the coverage and price level of each submarket.
``battery-plan dispatch`` solves the 4 x 2 portfolio of ``docs/model/model.md``
and writes every plan to one CSV, the file a web run stores in S3.
"""

from __future__ import annotations

import argparse
import sys
from collections.abc import Sequence
from pathlib import Path

import pandas as pd

from battery_plan.data_io import load_pld
from battery_plan.data_io.paths import RESULTS_DIR
from battery_plan.modelling import BusinessCase, HourlyBattery, Portfolio, solve_portfolio
from battery_plan.modelling.portfolio import CaseProgress
from battery_plan.result_v2 import plan_csv

DEFAULT_OUT = RESULTS_DIR / "dispatch_plan.csv"


def _inputs() -> int:
    prices = load_pld()
    print(f"Hourly PLD: {prices.index[0]:%Y-%m-%d} to {prices.index[-1]:%Y-%m-%d}")
    print(f"{len(prices):,} hours in each of {len(prices.columns)} submarkets")
    print(f"{'':4}{'mean':>10}{'min':>10}{'max':>10}  BRL/MWh")
    for submarket in prices.columns:
        series = prices[submarket]
        print(f"{submarket:4}{series.mean():10.2f}{series.min():10.2f}{series.max():10.2f}")
    return 0


def _report(portfolio: Portfolio) -> None:
    print("Merchant ranking (balanced year, BRL per year; a perfect-foresight ceiling)")
    regret = portfolio.regret()
    for result in portfolio.ranking():
        print(
            f"  {result.submarket:3}{result.balanced_year_brl:15,.0f}"
            f"   regret {regret[result.submarket]:12,.0f}"
            f"   {result.physical_cycles:7.1f} cycles"
        )
    contracted = [
        result for result in portfolio.results.values() if result.case is BusinessCase.CONTRACTED
    ]
    if contracted:
        print("Contracted case: dispatch proxy for cycles and losses, not revenue")
        for result in contracted:
            print(f"  {result.submarket:3}{result.physical_cycles:7.1f} cycles")
    for shortfall in portfolio.contract_shortfalls:
        print(f"Contract: {shortfall}")
    if portfolio.below_minimum_power:
        print("Below the auction's minimum power: this project cannot qualify.")


def _whole_days(prices: pd.DataFrame, start: str | None, end: str | None) -> pd.DataFrame:
    """The days from ``start`` to ``end``, inclusive, as ``slice_days`` cuts a series."""
    index = prices.index
    low = index[0] if start is None else pd.Timestamp(start).normalize()
    high = index[-1] + pd.Timedelta(hours=1)
    if end is not None:
        high = pd.Timestamp(end).normalize() + pd.Timedelta(days=1)
    selected: pd.DataFrame = prices.loc[(index >= low) & (index < high)]
    return selected


def _dispatch(args: argparse.Namespace) -> int:
    prices = _whole_days(load_pld(), args.start, args.end)
    if prices.empty:
        print("No PLD in those dates.", file=sys.stderr)
        return 2
    battery = HourlyBattery.sized(args.power_mw, hours=args.hours)

    def progress(event: CaseProgress) -> None:
        if not args.quiet:
            print(
                f"[{event.cases_done + 1}/{event.cases_total}] "
                f"{event.submarket} {event.case.value}",
                file=sys.stderr,
            )

    try:
        portfolio = solve_portfolio(prices, battery, on_case=progress)
    except ValueError as error:
        print(error, file=sys.stderr)
        return 2
    _report(portfolio)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_bytes(plan_csv(portfolio))
    print(f"Plans written to {args.out}")
    return 0


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="battery-plan", description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("inputs", help="print the coverage and level of the bundled PLD")
    dispatch = commands.add_parser("dispatch", help="solve every submarket and business case")
    dispatch.add_argument("--start", help="first day, YYYY-MM-DD (default: first in the data)")
    dispatch.add_argument("--end", help="last day, inclusive (default: last in the data)")
    dispatch.add_argument("--power-mw", type=float, default=30.0, help="delivered power")
    dispatch.add_argument("--hours", type=float, default=4.0, help="delivered duration")
    dispatch.add_argument("--out", type=Path, default=DEFAULT_OUT, help="the plan CSV")
    dispatch.add_argument("--quiet", action="store_true", help="results only, no progress")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    return _inputs() if args.command == "inputs" else _dispatch(args)


if __name__ == "__main__":
    raise SystemExit(main())
