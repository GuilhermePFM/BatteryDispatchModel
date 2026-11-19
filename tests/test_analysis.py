"""The readings of a plan, and the payload a results page is drawn from (§7)."""

from __future__ import annotations

import json
import math

import numpy as np
import pandas as pd
import pytest

from battery_plan.analysis import (
    build_result_payload,
    constraint_checks,
    daily_summary,
    fit,
    half_hour_profile,
    harvestable_spread,
    headline_figures,
    net_power_grid,
    profit_split,
    prorated_crossing,
    representative_week,
    trading_periods,
    with_derived_columns,
    yearly_summary,
)
from battery_plan.modelling import ModelParameters, RollingPolicy
from battery_plan.modelling.plan import summarise
from tests.helpers import SPEC, make_periods

PARAMS = ModelParameters.from_spec(SPEC)


def _plan(days: int = 9) -> pd.DataFrame:
    """A cheap night, a dear evening, and a day-to-day swing, solved for real."""
    rows = []
    for day in range(days):
        swing = 10.0 * (day % 3)
        rows += [20.0 + swing] * 24 + [60.0] * 12 + [140.0 - swing] * 12
    return RollingPolicy().dispatch(make_periods(rows), PARAMS)


@pytest.fixture(scope="module")
def plan() -> pd.DataFrame:
    return _plan()


def test_the_derived_columns_are_signed_and_leave_the_plan_alone(plan: pd.DataFrame) -> None:
    frame = with_derived_columns(plan)

    assert "net_mw" not in plan.columns
    np.testing.assert_allclose(frame["net_mw"], frame["discharge_mw"] - frame["charge_mw"])
    assert (frame["buy_at"] <= frame["sell_at"]).all()


def test_the_daily_rows_add_up_to_the_headline(plan: pd.DataFrame) -> None:
    daily = daily_summary(plan, PARAMS)
    figures = summarise(plan, PARAMS)

    assert len(daily) == 9
    assert daily["profit_gbp"].sum() == pytest.approx(figures["profit_gbp"])
    assert daily["cycles"].sum() == pytest.approx(figures["cycles_used"])
    assert daily["cycles_cumulative"].iloc[-1] == pytest.approx(figures["cycles_used"])
    assert (daily["day_range"] >= daily["harvestable_spread"] - 1e-9).all()


def test_harvestable_spread_averages_the_best_periods_against_the_cheapest() -> None:
    day = pd.DataFrame({"sell_at": [10.0, 50.0, 40.0, 30.0], "buy_at": [5.0, 1.0, 3.0, 9.0]})
    assert harvestable_spread(day, selling=2, buying=2) == pytest.approx(45.0 - 2.0)


def test_a_plan_that_never_trades_still_reads(plan: pd.DataFrame) -> None:
    idle = plan.copy()
    for column in ("charge_1_mw", "charge_2_mw", "discharge_1_mw", "discharge_2_mw"):
        idle[column] = 0.0
    assert trading_periods(idle) == (1, 1)
    assert math.isnan(headline_figures(idle.assign(cycles=0.0), PARAMS)["profit_per_cycle_gbp"])


def test_the_profit_split_is_exact(plan: pd.DataFrame) -> None:
    split = profit_split(plan, PARAMS)
    assert split["time_arbitrage_gbp"] + split["market_2_gap_gbp"] == pytest.approx(
        float(plan["net_revenue_gbp"].sum())
    )


def test_a_solved_plan_passes_its_own_constraint_checks(plan: pd.DataFrame) -> None:
    assert constraint_checks(plan, PARAMS).sum() == 0

    broken = plan.copy()
    broken.loc[broken.index[0], "discharge_1_mw"] = 5.0
    assert constraint_checks(broken, PARAMS)["over_rate_limit"] == 1


def test_the_mean_day_has_a_row_per_half_hour_and_shares_that_sum_to_one(
    plan: pd.DataFrame,
) -> None:
    profile = half_hour_profile(plan)
    assert len(profile) == 48 and profile.index[1] == 0.5
    shares = profile[["share_charging", "share_delivering", "share_idle"]].sum(axis=1)
    np.testing.assert_allclose(shares, 1.0)


def test_the_grid_is_half_hours_by_days(plan: pd.DataFrame) -> None:
    assert net_power_grid(plan).shape == (48, 9)


def test_the_week_is_seven_whole_days_or_the_whole_plan(plan: pd.DataFrame) -> None:
    week = representative_week(plan)
    assert len(week) == 7 * 48 and week.index[0].hour == 0
    assert len(representative_week(plan.iloc[: 3 * 48])) == 3 * 48


def test_fit_recovers_a_line_and_declines_a_constant() -> None:
    x = pd.Series([1.0, 2.0, 3.0, 4.0])
    slope, intercept, r2 = fit(x, 3.0 * x + 1.0)
    assert (slope, intercept, r2) == pytest.approx((3.0, 1.0, 1.0))
    assert all(math.isnan(value) for value in fit(pd.Series([2.0, 2.0]), x[:2]))


def test_the_prorated_budget_is_crossed_or_not(plan: pd.DataFrame) -> None:
    budget, crossed = prorated_crossing(plan, SPEC)
    assert budget == pytest.approx(SPEC.lifetime_cycles * 9 / 365.25 / SPEC.lifetime_years)
    if crossed is not None:
        assert plan["cycles"].loc[crossed] >= budget


def test_the_years_partition_the_horizon(plan: pd.DataFrame) -> None:
    by_year = yearly_summary(plan, daily_summary(plan, PARAMS))
    assert list(by_year.index) == [2024]
    assert by_year["profit_gbp"].sum() == pytest.approx(float(plan["net_revenue_gbp"].sum()))


def test_the_payload_is_plain_json_and_column_lengths_agree(plan: pd.DataFrame) -> None:
    payload = build_result_payload(plan, SPEC, PARAMS)
    text = json.dumps(payload, allow_nan=False)
    assert json.loads(text) == payload

    assert payload["certificate"] is None
    assert payload["headline"]["profit_gbp"] == pytest.approx(float(plan["net_revenue_gbp"].sum()))
    for name, block in payload["series"].items():
        if name in ("spread_histogram", "net_power"):
            continue
        assert len({len(column) for column in block.values()}) == 1, name
    grid = payload["series"]["net_power"]
    assert len(grid["values"]) == len(grid["days"]) == 9
    assert all(len(day) == len(grid["hours"]) == 48 for day in grid["values"])
    histogram = payload["series"]["spread_histogram"]
    assert len(histogram["edges"]) == len(histogram["counts"]) + 1
    assert sum(histogram["counts"]) == len(plan)


def test_a_year_of_payload_stays_well_inside_a_dynamodb_item() -> None:
    """400 KB is the item limit; the payload is held to well under it for a year."""
    year = pd.concat([_plan(30)] * 13).iloc[: 366 * 48]
    year.index = pd.date_range("2024-01-01", periods=len(year), freq="30min", name="timestamp")
    year["cycles"] = np.linspace(0.0, 1_100.0, len(year))
    year["effective_volume_mwh"] = PARAMS.nominal_volume_mwh * (
        1.0 - PARAMS.degradation_per_cycle * year["cycles"]
    )

    size = len(json.dumps(build_result_payload(year, SPEC, PARAMS), separators=(",", ":")))
    assert size < 200_000
