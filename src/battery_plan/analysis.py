"""What a dispatch plan did, read off its columns.

The readings of a plan, as functions: the price
landscape the plan was handed, what it did with it, where the profit came
from, the cycles it spent, and which reading of "the day's spread" explains
its daily profit. Each one is a pure function of the plan frame of
:mod:`battery_plan.modelling.plan` — plus the parameters or the spec where a
reading needs the battery — so the notebook and a solver job compute every
figure by one code path.

:func:`build_result_payload` is that same reading reduced to what a page can
draw: the headline figures, and the notebook's series aggregated far enough to
stay small — daily rows, monthly and quarterly bands, the mean day, the net
power grid, and one representative week at full resolution. It returns plain
JSON types, and its shape is ``contracts/result.schema.json``.

Nothing here solves anything, and nothing reads a file.
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np
import pandas as pd

from battery_plan.data_models import BatterySpec
from battery_plan.modelling.cycle_value.oracle import DualSearchResult
from battery_plan.modelling.parameters import ModelParameters, prorated_cycle_budget
from battery_plan.modelling.plan import summarise
from battery_plan.modelling.rolling_horizon import PERIODS_PER_DAY

#: Power below this is the solver's zero, not a decision to trade (MW) — the
#: same 10 W the plan itself rounds to.
TOLERANCE = 1e-5

#: Version of the payload :func:`build_result_payload` returns. Bumped on any
#: change a reader of ``result.schema.json`` would notice.
PAYLOAD_VERSION = 1

#: The spread histogram's range (£/MWh either side of zero) and its bin count.
SPREAD_CLIP = 20.0
SPREAD_BINS = 80

#: Days in the representative week drawn at full resolution.
WEEK_DAYS = 7


# -- the plan, extended ------------------------------------------------------


def with_derived_columns(plan: pd.DataFrame) -> pd.DataFrame:
    """The plan with the columns every reading below works in.

    Signed net power is what makes a dispatch figure readable: positive is
    delivering. ``buy_at`` and ``sell_at`` are a trader's view of the period
    with both markets open — buy at the cheaper, sell into the dearer — and
    everything that talks about "the day's prices" is built from them.
    """
    frame = plan.copy()
    frame["charge_mw"] = frame["charge_1_mw"] + frame["charge_2_mw"]
    frame["discharge_mw"] = frame["discharge_1_mw"] + frame["discharge_2_mw"]
    frame["net_mw"] = frame["discharge_mw"] - frame["charge_mw"]
    frame["spread"] = frame["price_2"] - frame["price_1"]
    frame["buy_at"] = frame[["price_1", "price_2"]].min(axis=1)
    frame["sell_at"] = frame[["price_1", "price_2"]].max(axis=1)
    return frame


def _derived(plan: pd.DataFrame) -> pd.DataFrame:
    return plan if "net_mw" in plan.columns else with_derived_columns(plan)


def _day(plan: pd.DataFrame) -> pd.DatetimeIndex:
    return pd.DatetimeIndex(plan.index).normalize()


def _half_hour(plan: pd.DataFrame) -> pd.Index:
    stamps = pd.DatetimeIndex(plan.index)
    return pd.Index(stamps.hour + stamps.minute / 60.0)


def trading_periods(plan: pd.DataFrame) -> tuple[int, int]:
    """Periods a day the plan sells in and buys in, on average: ``(selling, buying)``.

    These two counts calibrate :func:`harvestable_spread`: the battery does not
    take the day's one best trade, it takes about fourteen of them. Never less
    than one, so a plan that never traded still has a spread to read.
    """
    frame = _derived(plan)
    day = _day(frame)
    selling = round(float((frame["discharge_mw"] > TOLERANCE).groupby(day).sum().mean()))
    buying = round(float((frame["charge_mw"] > TOLERANCE).groupby(day).sum().mean()))
    return max(selling, 1), max(buying, 1)


def harvestable_spread(frame: pd.DataFrame, selling: int, buying: int) -> float:
    """Mean of the day's best ``selling`` periods less its cheapest ``buying`` ones.

    The day's range — its highest price less its lowest — is the spread on one
    perfect trade, and the battery makes about three cycles a day, so the range
    overstates what is reachable. Averaging the top prices against the bottom
    ones measures the same thing over the volume the battery can actually move.

    It stays exogenous: the two counts are calibrated once, on the plan's
    average behaviour, but each day's value is read off that day's prices alone
    and knows nothing of what the plan did that day.
    """
    top = np.sort(frame["sell_at"].to_numpy())[::-1][:selling].mean()
    bottom = np.sort(frame["buy_at"].to_numpy())[:buying].mean()
    return float(top - bottom)


def breakeven_markup(params: ModelParameters) -> float:
    """How far a sale has to beat its purchase before a round trip pays: ~11%."""
    return 1.0 / params.round_trip_efficiency - 1.0


def daily_summary(plan: pd.DataFrame, params: ModelParameters) -> pd.DataFrame:
    """One row per day: profit, cycles, the day's prices, and the yardstick.

    ``day_range`` is the one best trade available, which is what a question
    about whether *any* trade clears the round trip needs; ``harvestable_spread``
    is what the battery's own throughput can reach. ``yardstick_gbp`` is one
    perfect cycle of the nominal volume, bought at the day's floor and sold at
    its ceiling over both markets — not a bound, since it ignores the rate
    limits, the hourly commitment and the cycle cap, but the order-of-magnitude
    check.
    """
    frame = _derived(plan)
    day = _day(frame)
    selling, buying = trading_periods(frame)
    delivered = 1.0 - params.discharge_loss
    closing_cycles = frame["cycles"].resample("D").last()

    buy_floor = frame["buy_at"].groupby(day).min()
    sell_ceiling = frame["sell_at"].groupby(day).max()
    volume = params.nominal_volume_mwh
    daily = pd.DataFrame(
        {
            "profit_gbp": frame["net_revenue_gbp"].resample("D").sum(),
            "cycles": closing_cycles.diff().fillna(closing_cycles.iloc[0]),
            "cycles_cumulative": closing_cycles,
            "usable_volume_mwh": frame["effective_volume_mwh"].resample("D").last(),
            "mean_price": frame[["price_1", "price_2"]].mean(axis=1).resample("D").mean(),
            "buy_floor": buy_floor,
            "sell_ceiling": sell_ceiling,
            "day_range": sell_ceiling - buy_floor,
            "harvestable_spread": pd.Series(
                {
                    when: harvestable_spread(group, selling, buying)
                    for when, group in frame.groupby(day)
                }
            ),
            "delivered_mwh": params.dt * delivered * frame["discharge_mw"].resample("D").sum(),
            "yardstick_gbp": volume * delivered * sell_ceiling
            - volume / (1.0 - params.charge_loss) * buy_floor,
        }
    )
    daily.index.name = "day"
    return daily


# -- §1 the headline -------------------------------------------------------------


def headline_figures(plan: pd.DataFrame, params: ModelParameters) -> pd.Series:
    """:func:`~battery_plan.modelling.plan.summarise`, plus what is derived from it."""
    figures = summarise(plan, params)
    figures["periods_idle"] = int(
        figures["periods"] - figures["periods_charging"] - figures["periods_discharging"]
    )
    figures["profit_per_cycle_gbp"] = _ratio(figures["profit_gbp"], figures["cycles_used"])
    figures["degradation_pct"] = 100.0 * params.degradation_per_cycle * figures["cycles_used"]
    return figures


def market_pair(plan: pd.DataFrame, params: ModelParameters) -> pd.Series:
    """The markets as a pair: how often Market 2 is dearer, and what went where."""
    frame = _derived(plan)
    delivered = 1.0 - params.discharge_loss
    return pd.Series(
        {
            "share_market_2_dearer": float((frame["spread"] > 0).mean()),
            "mean_spread_gbp_per_mwh": float(frame["spread"].mean()),
            "bought_market_1_mwh": params.dt * float(frame["charge_1_mw"].sum()),
            "bought_market_2_mwh": params.dt * float(frame["charge_2_mw"].sum()),
            "delivered_market_1_mwh": params.dt * delivered * float(frame["discharge_1_mw"].sum()),
            "delivered_market_2_mwh": params.dt * delivered * float(frame["discharge_2_mw"].sum()),
        }
    )


# -- §2 the price landscape ------------------------------------------------------


def monthly_prices(plan: pd.DataFrame) -> pd.DataFrame:
    """Monthly mean price per market, with the inter-decile band around it."""
    monthly = plan[["price_1", "price_2"]].resample("MS")
    columns = {}
    for column in ("price_1", "price_2"):
        columns[f"{column}_mean"] = monthly[column].mean()
        columns[f"{column}_p10"] = monthly[column].quantile(0.1)
        columns[f"{column}_p90"] = monthly[column].quantile(0.9)
    return pd.DataFrame(columns)


def spread_histogram(
    plan: pd.DataFrame, clip: float = SPREAD_CLIP, bins: int = SPREAD_BINS
) -> tuple[np.ndarray, np.ndarray]:
    """Counts of ``price_2 - price_1`` per period, clipped at ``±clip``: ``(edges, counts)``."""
    spread = _derived(plan)["spread"].clip(-clip, clip)
    counts, edges = np.histogram(spread, bins=bins, range=(-clip, clip))
    return edges, counts


def days_worth_trading(daily: pd.DataFrame, params: ModelParameters) -> float:
    """Share of days whose range clears the round trip on the day's buying floor."""
    breakeven = daily["buy_floor"] * (1.0 + breakeven_markup(params))
    return float((daily["sell_ceiling"] > breakeven).mean())


# -- §3 what the plan does -------------------------------------------------------


def half_hour_profile(plan: pd.DataFrame) -> pd.DataFrame:
    """The mean day, by half hour: prices, power per market, and what the battery is doing."""
    frame = _derived(plan)
    by = frame.groupby(_half_hour(frame))
    profile = by[
        ["price_1", "price_2", "charge_1_mw", "charge_2_mw", "discharge_1_mw", "discharge_2_mw"]
    ].mean()
    profile["share_charging"] = (frame["charge_mw"] > TOLERANCE).groupby(_half_hour(frame)).mean()
    profile["share_delivering"] = (
        (frame["discharge_mw"] > TOLERANCE).groupby(_half_hour(frame)).mean()
    )
    profile["share_idle"] = 1.0 - profile["share_charging"] - profile["share_delivering"]
    profile.index.name = "hour"
    return profile


def net_power_grid(plan: pd.DataFrame) -> pd.DataFrame:
    """Net power with a row per half hour of the day and a column per day."""
    frame = _derived(plan)
    stamps = pd.DatetimeIndex(frame.index)
    grid = pd.DataFrame(
        {
            "net_mw": frame["net_mw"].to_numpy(),
            "day": stamps.normalize(),
            "period": stamps.hour * 2 + stamps.minute // 30,
        }
    )
    return grid.pivot_table(index="period", columns="day", values="net_mw")


def representative_week(plan: pd.DataFrame, days: int = WEEK_DAYS) -> pd.DataFrame:
    """The run of ``days`` whole days whose profit is the median of every such run.

    A week chosen for being typical rather than for being striking: the best
    week would show the battery at its busiest, which is the one thing a reader
    should not take as normal. A plan shorter than ``days`` is returned whole.
    """
    daily_profit = plan["net_revenue_gbp"].resample("D").sum()
    if len(daily_profit) <= days:
        return plan
    weekly = daily_profit.rolling(days).sum().dropna()
    end = pd.Timestamp((weekly - weekly.median()).abs().idxmin())  # type: ignore[arg-type]
    start = end - pd.Timedelta(days=days - 1)
    stamps = pd.DatetimeIndex(plan.index)
    return plan[(stamps >= start) & (stamps < end + pd.Timedelta(days=1))]


def constraint_checks(plan: pd.DataFrame, params: ModelParameters) -> pd.Series:
    """§4's constraints read off the plan, as counts of violations: all zero when it holds."""
    frame = _derived(plan)
    both = (frame["charge_mw"] > TOLERANCE) & (frame["discharge_mw"] > TOLERANCE)

    hourly = frame[["charge_2_mw", "discharge_2_mw"]].groupby(
        pd.DatetimeIndex(frame.index).floor("h")
    )
    flatness = hourly.max() - hourly.min()
    over_rate = (frame["charge_mw"] > params.max_charge_mw + TOLERANCE) | (
        frame["discharge_mw"] > params.max_discharge_mw + TOLERANCE
    )
    over_volume = frame["storage_mwh"] > frame["effective_volume_mwh"] + TOLERANCE
    return pd.Series(
        {
            "both_charging_and_delivering": int(both.sum()),
            "market_2_not_flat_hours": int((flatness > TOLERANCE).any(axis=1).sum()),
            "over_rate_limit": int(over_rate.sum()),
            "over_degraded_volume": int(over_volume.sum()),
            "over_cycle_budget": int(float(frame["cycles"].iloc[-1]) > params.cycle_budget),
        }
    )


# -- §4 where the profit comes from ----------------------------------------------


def profit_split(plan: pd.DataFrame, params: ModelParameters) -> pd.Series:
    """The profit as time arbitrage valued at Market 1, plus what Market 2 added.

    Valuing every decision at the Market 1 price of its own period gives the
    first part; the rest is what using Market 2 added, period by period. The
    split is exact — the parts sum to the profit — but the first part is a
    *valuation*, not a feasible plan: one confined to Market 1 would not face
    §4.5 and would choose different volumes.
    """
    frame = _derived(plan)
    delivered = 1.0 - params.discharge_loss
    at_market_1 = params.dt * float(
        (frame["price_1"] * (delivered * frame["discharge_mw"] - frame["charge_mw"])).sum()
    )
    from_market_2 = params.dt * float(
        (frame["spread"] * (delivered * frame["discharge_2_mw"] - frame["charge_2_mw"])).sum()
    )
    return pd.Series(
        {
            "time_arbitrage_gbp": at_market_1,
            "market_2_gap_gbp": from_market_2,
            "profit_gbp": at_market_1 + from_market_2,
        }
    )


def monthly_profit(plan: pd.DataFrame) -> pd.Series:
    """Profit by calendar month."""
    return plan["net_revenue_gbp"].resample("MS").sum()


def yearly_summary(plan: pd.DataFrame, daily: pd.DataFrame) -> pd.DataFrame:
    """Year by year, with the spread that explains it."""
    stamps = pd.DatetimeIndex(plan.index)
    years = plan.groupby(stamps.year)
    closing = years["cycles"].last()
    cycles = closing.diff().fillna(closing.iloc[0])
    profit = years["net_revenue_gbp"].sum()
    day_year = pd.DatetimeIndex(daily.index).year
    ratio = (daily["profit_gbp"] / daily["yardstick_gbp"]).replace([np.inf, -np.inf], np.nan)
    by_year = pd.DataFrame(
        {
            "profit_gbp": profit,
            "mean_price_1": years["price_1"].mean(),
            "mean_price_2": years["price_2"].mean(),
            "cycles": cycles,
            "mean_day_range": daily["day_range"].groupby(day_year).mean(),
            "mean_harvestable": daily["harvestable_spread"].groupby(day_year).mean(),
            "profit_per_cycle": profit / cycles.replace(0.0, np.nan),
            "yardstick_median_ratio": ratio.groupby(day_year).median(),
            "share_days_beating_yardstick": (daily["profit_gbp"] > daily["yardstick_gbp"])
            .groupby(day_year)
            .mean(),
        }
    )
    by_year.index.name = "year"
    return by_year


# -- §5 cycles and wear ----------------------------------------------------------


def prorated_crossing(plan: pd.DataFrame, spec: BatterySpec) -> tuple[float, pd.Timestamp | None]:
    """The pro-rated budget of §5 for this horizon, and when the plan crossed it, if it did."""
    prorated = prorated_cycle_budget(spec, len(plan))
    position = int(np.searchsorted(plan["cycles"].to_numpy(), prorated))
    crossed = pd.Timestamp(plan.index[position]) if position < len(plan) else None
    return prorated, crossed


def wear_cost(params: ModelParameters, figures: pd.Series, daily: pd.DataFrame) -> pd.Series:
    """What the wear cost, priced at the spreads the plan actually realised.

    Not a charge in the objective — §5 keeps degradation physical, in the
    volume — so this is the opportunity cost of the capacity given up, for
    context.
    """
    volume_lost = params.nominal_volume_mwh - float(figures["final_usable_volume_mwh"])
    margin = float(figures["mean_sell_price_gbp_per_mwh"] - figures["mean_buy_price_gbp_per_mwh"])
    per_day = float(daily["cycles"].mean())
    return pd.Series(
        {
            "volume_lost_mwh": volume_lost,
            "realised_margin_gbp_per_mwh": margin,
            "cycles_per_day": per_day,
            "forgone_per_year_gbp": volume_lost * margin * per_day * 365.25,
        }
    )


# -- §6 the spread, or the level -------------------------------------------------


def fit(x: pd.Series, y: pd.Series) -> tuple[float, float, float]:
    """Least-squares slope, intercept and R² for ``y`` on ``x``; NaN when it cannot be fitted."""
    mask = x.notna() & y.notna()
    xs, ys = x[mask].to_numpy(dtype=float), y[mask].to_numpy(dtype=float)
    if len(xs) < 2 or np.ptp(xs) == 0.0:
        return math.nan, math.nan, math.nan
    slope, intercept = np.polyfit(xs, ys, 1)
    residual = float(((ys - (slope * xs + intercept)) ** 2).sum())
    total = float(((ys - ys.mean()) ** 2).sum())
    return float(slope), float(intercept), 1.0 - residual / total if total else math.nan


#: The readings of "the day's spread", and whether each is a property of the
#: day (exogenous) or an output of the dispatch.
SPREAD_READINGS: dict[str, tuple[str, bool]] = {
    "day_range": ("the day's range", True),
    "harvestable_spread": ("harvestable spread", True),
    "volatility": ("within-day volatility", True),
    "market_gap": ("mean |market 2 - market 1|", True),
    "realised": ("realised by the plan", False),
    "price_level": ("the price level", True),
}


def spread_readings(
    plan: pd.DataFrame, params: ModelParameters, daily: pd.DataFrame
) -> pd.DataFrame:
    """Each reading of :data:`SPREAD_READINGS`, one row per day.

    The realised spread is what the plan itself paid and received that day.
    It is an output of the dispatch, not a property of the day, so explaining
    profit with it explains the result with the result; it is measured as a
    description and nothing more.
    """
    frame = _derived(plan)
    day = _day(frame)
    delivered = 1.0 - params.discharge_loss
    sold_gbp = (delivered * frame["discharge_mw"] * frame["sell_at"]).groupby(day).sum()
    sold_mwh = (delivered * frame["discharge_mw"] * params.dt).groupby(day).sum()
    bought_gbp = (frame["charge_mw"] * frame["buy_at"]).groupby(day).sum()
    bought_mwh = (frame["charge_mw"] * params.dt).groupby(day).sum()
    return pd.DataFrame(
        {
            "day_range": daily["day_range"],
            "harvestable_spread": daily["harvestable_spread"],
            "volatility": frame["sell_at"].groupby(day).std(),
            "market_gap": frame["spread"].abs().groupby(day).mean(),
            "realised": sold_gbp / sold_mwh.replace(0.0, np.nan)
            - bought_gbp / bought_mwh.replace(0.0, np.nan),
            "price_level": daily["mean_price"],
        }
    )


def spread_explanation(readings: pd.DataFrame, daily: pd.DataFrame) -> pd.DataFrame:
    """What each reading explains of daily profit: £ per unit, R², and whether it is exogenous."""
    rows = []
    for key in readings.columns:
        slope, _, r2 = fit(readings[key], daily["profit_gbp"])
        label, exogenous = SPREAD_READINGS[key]
        rows.append(
            {"key": key, "reading": label, "gbp_per_unit": slope, "r2": r2, "exogenous": exogenous}
        )
    return pd.DataFrame(rows).set_index("key")


def quarterly_level_and_spread(daily: pd.DataFrame) -> pd.DataFrame:
    """The price level and the harvestable spread by quarter — the two moving apart."""
    return pd.DataFrame(
        {
            "mean_price": daily["mean_price"].resample("QS").mean(),
            "harvestable_spread": daily["harvestable_spread"].resample("QS").mean(),
        }
    )


# -- §7 the yardstick and the costs left out -----------------------------------


def yardstick_summary(daily: pd.DataFrame, figures: pd.Series) -> pd.Series:
    """The plan against one ideal cycle a day, summed and counted."""
    total = float(daily["yardstick_gbp"].sum())
    return pd.Series(
        {
            "total_gbp": total,
            "ratio": _ratio(float(figures["profit_gbp"]), total),
            "days_below": int((daily["profit_gbp"] < daily["yardstick_gbp"]).sum()),
            "days": len(daily),
        }
    )


def lifetime_cost(spec: BatterySpec, periods: int) -> pd.Series:
    """Capex and the fixed opex of the horizon — the costs §5 leaves out, for context."""
    years = periods / (PERIODS_PER_DAY * 365.25)
    return pd.Series(
        {
            "years": years,
            "capex_gbp": spec.capex_gbp,
            "fixed_opex_gbp": spec.fixed_opex_gbp_per_year * years,
            "total_gbp": spec.capex_gbp + spec.fixed_opex_gbp_per_year * years,
        }
    )


def _ratio(numerator: float, denominator: float) -> float:
    return numerator / denominator if denominator else math.nan


# -- the payload -----------------------------------------------------------------


def build_result_payload(
    plan: pd.DataFrame,
    spec: BatterySpec,
    params: ModelParameters,
    search: DualSearchResult | None = None,
) -> dict[str, Any]:
    """Everything a results page draws, as plain JSON types (``contracts/result.schema.json``).

    Scalars are full precision; series are rounded to what a chart can show,
    and laid out column by column so a key is paid for once rather than once a
    row. Anything undefined — a ratio over nothing traded — is ``None``.
    ``search`` adds the certificate; without it that block is ``None``.
    """
    frame = with_derived_columns(plan)
    figures = headline_figures(frame, params)
    daily = daily_summary(frame, params)
    selling, buying = trading_periods(frame)
    prorated, crossed = prorated_crossing(frame, spec)
    split = profit_split(frame, params)
    costs = lifetime_cost(spec, len(frame))
    readings = spread_readings(frame, params, daily)
    stamps = pd.DatetimeIndex(frame.index)

    return {
        "version": PAYLOAD_VERSION,
        "horizon": {
            "start": _stamp(stamps[0]),
            "end": _stamp(stamps[-1]),
            "periods": len(frame),
            "days": len(daily),
            "period_minutes": params.dt * 60.0,
        },
        "battery": {
            "power_charge_mw": params.max_charge_mw,
            "power_discharge_mw": params.max_discharge_mw,
            "volume_mwh": params.nominal_volume_mwh,
            "round_trip_efficiency": params.round_trip_efficiency,
            "breakeven_markup": breakeven_markup(params),
            "degradation_per_cycle": params.degradation_per_cycle,
            "cycle_budget": params.cycle_budget,
        },
        "headline": _scalars(figures, counts=("periods",)),
        "certificate": _certificate(search, float(figures["profit_gbp"])),
        "markets": {
            **_scalars(market_pair(frame, params)),
            "share_days_worth_trading": _number(days_worth_trading(daily, params)),
            "selling_periods_per_day": selling,
            "buying_periods_per_day": buying,
        },
        "profit_split": {
            **_scalars(split),
            "market_2_share": _number(_ratio(split["market_2_gap_gbp"], split["profit_gbp"])),
        },
        "cycles": {
            "used": _number(figures["cycles_used"]),
            "budget": params.cycle_budget,
            "prorated_budget": prorated,
            "prorated_crossed_at": None if crossed is None else _stamp(crossed),
            **_scalars(wear_cost(params, figures, daily)),
        },
        "yardstick": {
            **_scalars(yardstick_summary(daily, figures), counts=("days",)),
            "volume_mwh": params.nominal_volume_mwh,
        },
        "costs": {
            **_scalars(costs),
            "shortfall_gbp": _number(costs["total_gbp"] - figures["profit_gbp"]),
        },
        "checks": {key: int(value) for key, value in constraint_checks(frame, params).items()},
        "spread_explanation": [
            {
                "key": key,
                "reading": row["reading"],
                "gbp_per_unit": _number(row["gbp_per_unit"]),
                "r2": _number(row["r2"]),
                "exogenous": bool(row["exogenous"]),
            }
            for key, row in spread_explanation(readings, daily).iterrows()
        ],
        "series": {
            "daily": _columns(
                daily,
                "date",
                _date,
                digits=2,
                overrides={"cycles": 4, "cycles_cumulative": 3, "usable_volume_mwh": 5},
            ),
            "monthly": _columns(
                monthly_prices(frame).assign(profit_gbp=monthly_profit(frame)), "month", _date
            ),
            "quarterly": _columns(quarterly_level_and_spread(daily), "quarter", _date),
            "yearly": _columns(yearly_summary(frame, daily), "year", int, digits=4),
            "profile": _columns(half_hour_profile(frame), "hour", float, digits=4),
            "spread_histogram": _histogram(frame),
            "net_power": _grid(net_power_grid(frame)),
            "week": _columns(
                representative_week(frame)[
                    [
                        "price_1",
                        "price_2",
                        "charge_1_mw",
                        "charge_2_mw",
                        "discharge_1_mw",
                        "discharge_2_mw",
                        "storage_mwh",
                    ]
                ],
                "timestamp",
                _stamp,
                digits=3,
            ),
        },
    }


def _certificate(search: DualSearchResult | None, profit: float) -> dict[str, Any] | None:
    """The cycle value, its cost in passes, and the dual bound when the method has one.

    ``stopped_early`` says the search was cut short by its deadline rather
    than by its own criterion; the plan is still within budget, and
    ``plan_gap`` is then the measure of what stopping cost.
    """
    if search is None:
        return None
    bound = search.bound
    return {
        "cycle_value": search.cycle_value,
        "passes": search.passes,
        "stopped_early": search.stopped_early,
        "stop_reason": search.stop_reason,
        "dual_bound_gbp": None if bound is None else _number(bound.lagrangian),
        "dual_gap": None if bound is None else _number(bound.relative_gap),
        "plan_gap": None
        if bound is None
        else _number(_ratio(bound.lagrangian - profit, bound.lagrangian)),
    }


def _histogram(frame: pd.DataFrame) -> dict[str, Any]:
    edges, counts = spread_histogram(frame)
    return {
        "clip": SPREAD_CLIP,
        "edges": [round(float(edge), 3) for edge in edges],
        "counts": [int(count) for count in counts],
    }


def _grid(grid: pd.DataFrame) -> dict[str, Any]:
    """The net power grid a row per day, so a day is one array of its half hours.

    To a tenth of a MW: the grid is a colour per cell, and it is most of the
    payload's size.
    """
    return {
        "days": [_date(day) for day in grid.columns],
        "hours": [period / 2.0 for period in grid.index],
        "values": [_rounded(grid[day].to_numpy(), 1) for day in grid.columns],
    }


def _columns(
    frame: pd.DataFrame,
    key: str,
    label: Any,
    *,
    digits: int = 2,
    overrides: dict[str, int] | None = None,
) -> dict[str, list[Any]]:
    """A frame as ``{key: [index...], column: [values...]}``, rounded per column."""
    places = overrides or {}
    out: dict[str, list[Any]] = {key: [label(value) for value in frame.index]}
    for column in frame.columns:
        out[str(column)] = _rounded(frame[column].to_numpy(dtype=float), places.get(column, digits))
    return out


def _rounded(values: np.ndarray, digits: int) -> list[float | int | None]:
    """Rounded for a chart, with a whole number written as one: ``0`` costs less than ``0.0``."""
    out: list[float | int | None] = []
    for value in values:
        if not math.isfinite(value):
            out.append(None)
            continue
        number = round(float(value), digits)
        out.append(int(number) if number.is_integer() else number)
    return out


def _scalars(series: pd.Series, counts: tuple[str, ...] = ()) -> dict[str, Any]:
    """A series of figures as a dict, with the keys starting with ``counts`` as integers.

    A series holding both money and period counts is all float, so the counts
    have to be named to come back out as the integers they are.
    """
    return {
        str(key): int(value) if str(key).startswith(counts) and counts else _number(value)
        for key, value in series.items()
    }


def _number(value: Any) -> float | int | None:
    """A plain number, or ``None`` where there is none to give (NaN, infinity)."""
    if isinstance(value, (bool, np.bool_)):
        return int(value)
    if isinstance(value, (int, np.integer)):
        return int(value)
    number = float(value)
    return number if math.isfinite(number) else None


def _date(value: Any) -> str:
    return f"{pd.Timestamp(value):%Y-%m-%d}"


def _stamp(value: Any) -> str:
    return f"{pd.Timestamp(value):%Y-%m-%dT%H:%M:%S}"
