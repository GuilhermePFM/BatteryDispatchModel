"""Command line entry point: ``battery-plan``."""

from __future__ import annotations

import argparse
import time
from collections.abc import Sequence
from dataclasses import asdict
from pathlib import Path

import pandas as pd

from battery_plan.data_io import load_battery_spec, load_market_prices, price_quality_report
from battery_plan.data_io.paths import BATTERY_SPEC_XLSX, MARKET_PRICES_XLSX, RESULTS_DIR
from battery_plan.dispatch import DispatchConfig, DispatchInterrupted, run_dispatch
from battery_plan.modelling import ModelParameters, summarise
from battery_plan.modelling.cycle_value.oracle import CycleOracle, DualSearchResult
from battery_plan.modelling.cycle_value.searches import DEFAULT_SEARCH, SEARCHES
from battery_plan.reporting import PROGRESS_MODES, make_reporter, passes_phrase


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="battery-plan", description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    inputs = subparsers.add_parser("inputs", help="Print the loaded battery spec and price data")
    inputs.add_argument("--spec", default=BATTERY_SPEC_XLSX, help="Path to the battery spec")
    inputs.add_argument("--prices", default=MARKET_PRICES_XLSX, help="Path to the prices")
    inputs.set_defaults(func=_cmd_inputs)

    dispatch = subparsers.add_parser("dispatch", help="Solve the dispatch model and report profit")
    dispatch.add_argument("--spec", default=BATTERY_SPEC_XLSX, help="Path to the battery spec")
    dispatch.add_argument("--prices", default=MARKET_PRICES_XLSX, help="Path to the prices")
    dispatch.add_argument("--start", help="First timestamp to dispatch over (default: all data)")
    dispatch.add_argument("--end", help="Last timestamp to dispatch over (default: all data)")
    dispatch.add_argument(
        "--commit-days",
        type=int,
        default=1,
        help="Days committed per solved window (default: 1)",
    )
    dispatch.add_argument(
        "--lookahead-days",
        type=int,
        default=1,
        help="Days of foresight beyond the committed window, then discarded (default: 1)",
    )
    dispatch.add_argument(
        "--search",
        default=DEFAULT_SEARCH,
        choices=sorted(SEARCHES),
        help=(
            f"Method that values the cycle budget (§6, default: {DEFAULT_SEARCH}). "
            "Costs one pass over the horizon per step"
        ),
    )
    dispatch.add_argument(
        "--out",
        default=RESULTS_DIR / "dispatch_plan.csv",
        help="Where to write the half-hourly plan (.csv, or .parquet)",
    )
    dispatch.add_argument(
        "--progress",
        default="auto",
        choices=PROGRESS_MODES,
        help=(
            "How the run reports itself on stderr: a live console, one log line "
            "per event, JSON lines, or nothing (default: auto, which reads the terminal)"
        ),
    )
    dispatch.add_argument(
        "--quiet",
        action="store_true",
        help="Print the results only; shorthand for --progress none",
    )
    dispatch.set_defaults(func=_cmd_dispatch)

    return parser


def _cmd_inputs(args: argparse.Namespace) -> int:
    spec = load_battery_spec(args.spec)
    prices = load_market_prices(args.prices)

    print("Battery spec")
    for field, value in asdict(spec).items():
        print(f"  {field:<32} {value:>12,.10g}")

    print("\nMarket prices")
    for name, series in (
        ("Market 1 (half-hourly)", prices.market_1),
        ("Market 2 (hourly)", prices.market_2),
    ):
        print(
            f"  {name:<24} {len(series):>7,} periods  "
            f"{series.index[0]:%Y-%m-%d} to {series.index[-1]:%Y-%m-%d}  "
            f"mean £{series.mean():,.2f}/MWh"
        )

    print("\nData quality")
    print(price_quality_report(prices).to_string())
    return 0


def _cmd_dispatch(args: argparse.Namespace) -> int:
    """Dispatch the horizon, reporting each phase as it goes.

    The split that matters here is the old one, kept strict: the *result* goes
    to stdout, so ``battery-plan dispatch > summary.txt`` still captures it,
    and everything about the run in progress goes to the reporter on stderr.
    The run itself is :func:`~battery_plan.dispatch.run_dispatch`; what is left
    here is the files on either side of it.
    """
    started = time.perf_counter()
    reporter = make_reporter("none" if args.quiet else args.progress)

    spec = load_battery_spec(args.spec)
    prices = load_market_prices(args.prices)
    config = DispatchConfig(
        start=args.start,
        end=args.end,
        commit_days=args.commit_days,
        lookahead_days=args.lookahead_days,
        search=args.search,
    )
    try:
        run = run_dispatch(
            spec, prices, config, reporter=reporter, out_path=str(args.out), started=started
        )
    except DispatchInterrupted as stop:
        return _interrupted(stop.oracle, args, stop.params)

    _print_results(run.search, run.params, args.search)
    _write(run.plan, Path(args.out))
    return 0


def _print_results(result: DualSearchResult, params: ModelParameters, method: str) -> None:
    """The two blocks the run exists to produce: the plan, and its certificate.

    They are separated because they answer different questions. The plan is
    what the battery would do; the certificate is how far that could be from
    the best possible, which is a claim about the *method*, not the battery.
    """
    figures = summarise(result.plan, params)
    spent, budget = figures["cycles_used"], figures["cycle_budget"]

    print("\nPlan")
    _row("profit", f"{figures['profit_gbp']:,.2f}", "GBP")
    _row(
        "  market 1 / market 2",
        _pair(figures["net_revenue_market_1_gbp"], figures["net_revenue_market_2_gbp"]),
        "GBP",
    )
    _row("  income / cost", _pair(figures["income_gbp"], figures["cost_gbp"]), "GBP")
    _row(
        "mean buy / sell",
        _pair(figures["mean_buy_price_gbp_per_mwh"], figures["mean_sell_price_gbp_per_mwh"]),
        "GBP/MWh",
    )
    _row(
        "energy bought / delivered",
        _pair(figures["energy_bought_mwh"], figures["energy_delivered_mwh"]),
        "MWh",
    )
    _row("cycles used", f"{spent:,.1f} of {budget:,.0f}", f"({spent / budget:.2%})")
    _row(
        "periods charging / discharging",
        f"{int(figures['periods_charging']):,} / {int(figures['periods_discharging']):,}",
        f"of {int(figures['periods']):,}",
    )
    _row(
        "final storage / usable volume",
        _pair(figures["final_storage_mwh"], figures["final_usable_volume_mwh"]),
        "MWh",
    )

    print("\nCertificate")
    _row("cycle value", f"{result.cycle_value:,.2f}", "GBP/cycle")
    _row("horizon passes spent", f"{result.passes:,d}")
    if result.bound is None:
        # Bisection reads one bit per pass and has no bound to offer (§6).
        _row("dual bound on profit", "not available")
        print(f"  note  {method} reads one bit per pass, so it certifies nothing;")
        print("        use --search cutting-plane for a bound on profit")
        return

    delivered_gap = (result.bound.lagrangian - figures["profit_gbp"]) / result.bound.lagrangian
    _row("dual bound on profit", f"{result.bound.lagrangian:,.2f}", "GBP")
    _row("dual gap, search", f"{result.bound.relative_gap:.3%}")
    _row("gap, plan vs bound", f"{delivered_gap:.2%}")
    print("  note  the bound is exact for the relaxed problem; the rolling policy's")
    print("        lookahead is finite, so read the last figure as an upper limit on")
    print("        what better foresight could add, not a solver tolerance")


#: Width of the value column, so every figure in both blocks lines up on one edge.
VALUE_WIDTH = 24


def _row(label: str, value: str, unit: str = "") -> None:
    """One label/value line, with every value on the same right edge."""
    print(f"  {label:<32}{value:>{VALUE_WIDTH}}" + (f"  {unit}" if unit else ""))


def _pair(first: float, second: float) -> str:
    """Two figures read as a ratio, printed as one."""
    return f"{first:,.2f} / {second:,.2f}"


def _interrupted(oracle: CycleOracle, args: argparse.Namespace, params: ModelParameters) -> int:
    """Write the best plan the run already paid for, rather than losing it.

    Every pass is a full horizon solve, so an interrupted run has usually
    bought something worth keeping: the best *within-budget* point among the
    passes already spent is a deliverable plan, whatever the search was about
    to try next.
    """
    feasible = [point for point in oracle.points if point.within_budget]
    out = Path(args.out).with_suffix(f".partial{Path(args.out).suffix}")

    if not feasible:
        oracle.reporter.interrupted(
            [
                f"after {passes_phrase(oracle.passes)}, none of them within the "
                f"{params.cycle_budget:,.0f}-cycle budget",
                "nothing to write — every pass solved so far was a relaxed evaluation",
            ]
        )
        return 130

    best = max(feasible, key=lambda point: point.profit)
    oracle.reporter.interrupted(
        [
            f"by user, after {passes_phrase(oracle.passes)}",
            f"best plan within budget: pass {best.index} "
            f"\u00b7 \u03bb {best.cycle_value:,.2f} "
            f"\u00b7 {best.cycles:,.1f} cycles \u00b7 {best.profit:,.0f} GBP",
            f"written to {out}",
            f"resume with  --search {args.search} --start {args.start or 'all'}",
        ]
    )
    _write(best.plan, out)
    return 130


def _write(plan: pd.DataFrame, out: Path) -> None:
    """Write the half-hourly plan where ``--out`` asked for it."""
    out.parent.mkdir(parents=True, exist_ok=True)
    if out.suffix == ".parquet":
        plan.to_parquet(out)
    else:
        plan.to_csv(out)
    print(f"\n-> {out}  ({len(plan):,} rows)")


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    result: int = args.func(args)
    return result


if __name__ == "__main__":
    raise SystemExit(main())
