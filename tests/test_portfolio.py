"""The 4x2 grid, the balanced year and the 24+0 backtest."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from battery_plan.data_io import SUBMARKETS, load_pld
from battery_plan.modelling.hourly import HourlyBattery, solve_hourly
from battery_plan.modelling.portfolio import (
    DAYS_IN_MONTH,
    BusinessCase,
    Portfolio,
    backtest_day_ahead,
    balanced_year,
    capture_factor,
    last_twelve_months,
    solve_case,
    solve_portfolio,
)


def daily(start: str, end: str, value: float = 1.0) -> pd.Series:
    index = pd.date_range(start, end, freq="D")
    return pd.Series(value, index=index, dtype=float)


def week_of_prices() -> pd.DataFrame:
    rng = np.random.default_rng(11)
    index = pd.date_range("2025-03-03", periods=7 * 24, freq="h")
    shape = 100 + 80 * np.sin((index.hour.to_numpy() - 12) / 24 * 2 * np.pi)
    return pd.DataFrame(
        {name: shape * rng.uniform(0.8, 1.2, len(index)) + 5 for name in SUBMARKETS}, index=index
    )


def test_a_reference_year_has_365_days() -> None:
    assert sum(DAYS_IN_MONTH.values()) == 365
    assert DAYS_IN_MONTH[2] == 28


def test_a_constant_day_value_balances_to_365_days() -> None:
    assert balanced_year(daily("2025-01-20", "2026-11-20", 2.0)) == pytest.approx(730.0)


def test_a_month_seen_twice_does_not_count_twice() -> None:
    series = daily("2025-01-01", "2026-01-31")
    series[series.index >= "2026-01-01"] = 3.0
    # January is the mean of a 1.0 year and a 3.0 year: 31 days at 2.0.
    assert balanced_year(series) == pytest.approx(365 + 31)


def test_a_balanced_year_needs_every_month() -> None:
    with pytest.raises(ValueError, match="all 12 months"):
        balanced_year(daily("2025-01-01", "2025-06-30"))


def test_the_month_index_restates_values_and_must_cover_them() -> None:
    series = daily("2025-01-01", "2025-12-31")
    factors = {202500 + month: 2.0 for month in range(1, 13)}
    assert balanced_year(series, factors) == pytest.approx(730.0)
    del factors[202503]
    with pytest.raises(ValueError, match="no index"):
        balanced_year(series, factors)


def test_the_last_twelve_months_end_on_the_last_day() -> None:
    assert last_twelve_months(daily("2025-01-20", "2026-11-20")) == pytest.approx(365.0)


def test_the_grid_is_four_submarkets_by_two_cases() -> None:
    grid = solve_portfolio_week(week_of_prices())
    assert len(grid) == 8
    assert {key[1] for key in grid} == set(BusinessCase)


def solve_portfolio_week(prices: pd.DataFrame) -> dict[tuple[str, BusinessCase], float]:
    """The grid over a week, without the annual figures a week cannot produce."""
    battery = HourlyBattery.sized(1.0)
    return {
        (str(name), case): solve_case(prices[name], battery, case).value
        for name in prices.columns
        for case in BusinessCase
    }


def test_the_merchant_case_is_never_worth_less_than_the_contracted_proxy() -> None:
    grid = solve_portfolio_week(week_of_prices())
    for name in SUBMARKETS:
        merchant = grid[(name, BusinessCase.MERCHANT)]
        assert merchant >= grid[(name, BusinessCase.CONTRACTED)] - 1e-6


@pytest.fixture(scope="module")
def real_grid() -> Portfolio:
    return solve_portfolio(load_pld(), HourlyBattery.sized(1.0), time_limit=600.0)


@pytest.mark.slow
def test_the_real_grid_ranks_on_the_merchant_case(real_grid: Portfolio) -> None:
    assert len(real_grid.results) == 8
    ranked = real_grid.ranking()
    values = [result.balanced_year_brl for result in ranked]
    assert values == sorted(values, reverse=True)
    assert all(result.case is BusinessCase.MERCHANT for result in ranked)
    regret = real_grid.regret()
    assert regret[ranked[0].submarket] == 0.0
    assert min(regret.values()) == 0.0


def test_a_short_battery_keeps_the_merchant_case_and_names_the_shortfall() -> None:
    prices = load_pld().iloc[: 400 * 24]
    grid = solve_portfolio(prices, HourlyBattery.sized(1.0, hours=2.0))
    assert len(grid.results) == 4
    assert all(key[1] is BusinessCase.MERCHANT for key in grid.results)
    assert grid.contract_shortfalls
    assert grid.below_minimum_power


def test_the_backtest_decides_a_day_without_seeing_the_next() -> None:
    """A price jump tomorrow must not change what the backtest does today."""
    calm = pd.Series(
        [50.0] * 12 + [90.0] * 12 + [50.0] * 12 + [90.0] * 12,
        index=pd.date_range("2025-03-03", periods=48, freq="h"),
        name="SE",
    )
    spiked = calm.copy()
    spiked.iloc[24:] = 900.0
    battery = HourlyBattery.sized(1.0)
    first_day = 24
    np.testing.assert_allclose(
        backtest_day_ahead(calm, battery).discharge_mw[:first_day],
        backtest_day_ahead(spiked, battery).discharge_mw[:first_day],
        atol=1e-6,
    )


def test_perfect_foresight_is_a_ceiling_on_the_backtest() -> None:
    prices = week_of_prices()["SE"]
    battery = HourlyBattery.sized(1.0)
    assert backtest_day_ahead(prices, battery).value <= solve_hourly(prices, battery).value + 1e-6


def test_the_backtest_carries_the_state_across_midnight() -> None:
    prices = week_of_prices()["SE"]
    battery = HourlyBattery.sized(1.0)
    solved = backtest_day_ahead(prices, battery)
    opening = np.concatenate([[0.0], solved.storage_mwh[:-1]])
    np.testing.assert_allclose(
        solved.storage_mwh,
        opening + battery.charge_efficiency * solved.charge_mw - solved.discharge_mw,
        atol=1e-6,
    )
    np.testing.assert_allclose(solved.cycles, np.cumsum(solved.discharge_mw) / battery.volume_mwh)


@pytest.mark.slow
def test_the_capture_factor_on_real_prices_is_a_fraction() -> None:
    prices = load_pld()["SE"].rename("SE")
    factor = capture_factor(prices, HourlyBattery.sized(1.0))
    assert 0.5 < factor.balanced <= 1.0
    assert 0.5 < factor.last_twelve_months <= 1.0
