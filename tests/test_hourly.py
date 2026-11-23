"""The hourly PLD program: the LP claim of §5.1 and the contract limits of §4.5."""

from __future__ import annotations

from dataclasses import replace

import numpy as np
import pandas as pd
import pulp
import pytest

from battery_plan.data_io import load_pld
from battery_plan.modelling.hourly import (
    CRCAP_LIMITS,
    HOURS_PER_DAY,
    HOURS_PER_YEAR,
    ContractLimits,
    HourlyBattery,
    HourlySolution,
    HourlyState,
    _build_program,
    hourly_series,
    net_flows,
    slice_days,
    solve_contracted,
    solve_hourly,
)

TOLERANCE = 1e-6

#: Two price peaks a day, the shape that makes a battery cycle twice.
TWO_PEAKS: list[float] = [
    *(60, 55, 50, 50, 55, 70, 200, 260, 180, 90, 60, 50),
    *(45, 40, 45, 60, 120, 240, 320, 280, 150, 90, 70, 65),
]


@pytest.fixture
def exact_milp(monkeypatch: pytest.MonkeyPatch) -> None:
    """Close the MILP gap, so that comparisons between solves test the logic alone."""
    monkeypatch.setattr("battery_plan.modelling.hourly.MILP_GAP", 1e-8)


def hourly(values: list[float], start: str = "2025-03-03") -> pd.Series:
    return pd.Series(
        values, index=pd.date_range(start, periods=len(values), freq="h"), dtype=float, name="SE"
    )


def seeded_prices(days: int, seed: int) -> pd.Series:
    """Noisy two-peak days, so that no test leans on one lucky shape."""
    noise = np.random.default_rng(seed).uniform(0.7, 1.3, days * HOURS_PER_DAY)
    return hourly(list(np.array(TWO_PEAKS * days) * noise))


def with_exclusive_binary(prices: pd.Series, battery: HourlyBattery) -> float:
    """The same program with the charge/discharge binary that §5.1 proves unnecessary."""
    problem, charge, discharge, _, _ = _build_program(
        prices, battery, None, frozenset(), HourlyState()
    )
    charging = problem.add_variable_matrix("u", range(len(prices)), cat="Binary")
    for t in range(len(prices)):
        problem += charge[t] <= battery.max_charge_mw * charging[t], f"only_charge_{t}"
        problem += discharge[t] <= battery.max_discharge_mw * (1 - charging[t]), f"only_dis_{t}"
    stats = problem.solve(pulp.HiGHS(msg=False, gapRel=1e-9))
    assert stats.status is pulp.LpSolveStatus.Optimal
    objective = pulp.value(problem.objective)
    assert objective is not None
    return float(objective)


def assert_physical(solution: HourlySolution, battery: HourlyBattery) -> None:
    """§4.1 to §4.7, hour by hour, on the plan as returned."""
    charge, discharge, storage = solution.charge_mw, solution.discharge_mw, solution.storage_mwh
    assert charge.min() >= -TOLERANCE
    assert discharge.min() >= -TOLERANCE
    assert charge.max() <= battery.max_charge_mw + TOLERANCE
    assert discharge.max() <= battery.max_discharge_mw + TOLERANCE
    assert np.minimum(charge, discharge).max() <= TOLERANCE

    opening = np.concatenate([[0.0], storage[:-1]])
    np.testing.assert_allclose(
        storage, opening + battery.charge_efficiency * charge - discharge, atol=1e-5
    )
    np.testing.assert_allclose(solution.cycles, np.cumsum(discharge) / battery.volume_mwh)
    assert storage.min() >= -TOLERANCE
    ceiling = battery.volume_mwh * (1 - battery.degradation_per_cycle * solution.cycles)
    assert (storage <= ceiling + 1e-5).all()


# --- The hourly LP -----------------------------------------------------------------------


@pytest.mark.parametrize("seed", range(4))
@pytest.mark.parametrize("hours", [2.0, 4.0, 8.0])
def test_the_lp_equals_the_milp_with_the_exclusivity_binary(seed: int, hours: float) -> None:
    prices = seeded_prices(4, seed)
    battery = HourlyBattery.sized(1.0, hours=hours)
    lp = solve_hourly(prices, battery)
    assert lp.value == pytest.approx(with_exclusive_binary(prices, battery), rel=1e-6)


@pytest.mark.parametrize("seed", range(4))
def test_the_lp_never_charges_and_discharges_together(seed: int) -> None:
    battery = HourlyBattery.sized(1.0)
    solution = solve_hourly(seeded_prices(7, seed), battery)
    assert_physical(solution, battery)


def test_netting_removes_overlap_and_keeps_the_storage_path() -> None:
    charge = np.array([1.0, 0.5, 0.0, 0.2])
    discharge = np.array([0.5, 2.0, 0.3, 0.0])
    netted_charge, netted_discharge = net_flows(charge, discharge, 0.9)
    assert np.minimum(netted_charge, netted_discharge).max() == 0.0
    np.testing.assert_allclose(0.9 * netted_charge - netted_discharge, 0.9 * charge - discharge)


def test_netting_settles_the_ties_of_a_zero_loss_battery() -> None:
    battery = HourlyBattery(1.0, 4.0, 1.0, 1.0, 1.0, 1.0, degradation_per_cycle=0.0)
    solution = solve_hourly(hourly([50.0] * HOURS_PER_DAY), battery)
    assert np.minimum(solution.charge_mw, solution.discharge_mw).max() == 0.0
    assert solution.value == pytest.approx(0.0, abs=1e-6)


def test_one_day_is_24_rows() -> None:
    assert HOURS_PER_DAY == 24
    prices = load_pld()["SE"]
    day = slice_days(prices, "2025-06-20", "2025-06-20")
    assert len(day) == 24
    assert day.index[0] == pd.Timestamp("2025-06-20 00:00")
    assert day.index[-1] == pd.Timestamp("2025-06-20 23:00")
    assert len(solve_hourly(day, HourlyBattery.sized(1.0))) == 24


def test_an_inclusive_day_end_would_add_a_25th_hour() -> None:
    """The trap the open upper edge of ``slice_days`` exists to avoid."""
    prices = load_pld()["SE"]
    inclusive = prices.loc[pd.Timestamp("2025-06-20") : pd.Timestamp("2025-06-21")]
    assert len(inclusive) == 25
    assert len(slice_days(prices, "2025-06-20", "2025-06-20")) == 24


def test_a_day_keeps_its_local_price_shape() -> None:
    """Prices stay on their local hour, so the evening peak is discharged in the evening."""
    prices = hourly(TWO_PEAKS)
    solution = solve_hourly(prices, HourlyBattery.sized(1.0))
    evening = solution.index.hour == 18
    assert solution.discharge_mw[evening].sum() > 0
    assert solution.charge_mw[evening].sum() == pytest.approx(0.0, abs=TOLERANCE)


@pytest.mark.parametrize(
    "broken",
    [
        hourly([50.0, 0.0, 60.0]),
        hourly([50.0, -1.0, 60.0]),
        hourly([50.0, float("nan"), 60.0]),
        hourly([50.0, 60.0, 70.0]).tz_localize("America/Sao_Paulo"),
        hourly([50.0, 60.0, 70.0]).iloc[np.array([0, 2])],
        hourly([50.0, 60.0, 70.0]).iloc[np.array([0, 0, 1])],
        hourly([]),
    ],
)
def test_prices_the_program_cannot_trust_are_refused(broken: pd.Series) -> None:
    with pytest.raises(ValueError):
        hourly_series(broken)


def test_the_default_sizing_meets_the_contract_exactly() -> None:
    battery = HourlyBattery.sized(30.0)
    assert CRCAP_LIMITS.sizing_shortfalls(battery) == ()
    assert CRCAP_LIMITS.contract_cycles_per_physical(battery) == pytest.approx(1.0)
    assert battery.round_trip_efficiency == pytest.approx(0.85)
    assert battery.discharge_efficiency * battery.volume_mwh == pytest.approx(120.0)
    assert battery.max_charge_mw == pytest.approx(30.0)
    assert battery.max_discharge_mw * battery.discharge_efficiency == pytest.approx(30.0)


@pytest.mark.parametrize(
    ("battery", "expected"),
    [
        (HourlyBattery.sized(1.0, hours=2.0), "delivers less"),
        (HourlyBattery.sized(1.0, round_trip_efficiency=0.8), "round-trip"),
        (HourlyBattery.sized(1.0, recharge_hours=8.0), "recharge"),
        (replace(HourlyBattery.sized(1.0), max_discharge_mw=0.5), "discharge rate"),
    ],
)
def test_a_battery_outside_the_contract_is_named_and_refused(
    battery: HourlyBattery, expected: str
) -> None:
    assert any(expected in shortfall for shortfall in CRCAP_LIMITS.sizing_shortfalls(battery))
    with pytest.raises(ValueError, match="cannot meet the contract"):
        solve_contracted(hourly(TWO_PEAKS), battery)


def test_the_recharge_limit_applies_to_the_contracted_storage() -> None:
    # 8 h of volume on an 8 h recharge stores the contracted 4 h in 4 h.
    assert not CRCAP_LIMITS.sizing_shortfalls(HourlyBattery.sized(30.0, hours=8, recharge_hours=8))
    # The edge: 12 h for the whole 8 h volume is 6 h for the contracted half.
    assert not CRCAP_LIMITS.sizing_shortfalls(HourlyBattery.sized(30.0, hours=8, recharge_hours=12))
    late = CRCAP_LIMITS.sizing_shortfalls(HourlyBattery.sized(30.0, hours=8, recharge_hours=12.5))
    assert any("recharge" in shortfall for shortfall in late)


def test_under_30_mw_is_a_warning_and_still_solves() -> None:
    battery = HourlyBattery.sized(10.0)
    assert CRCAP_LIMITS.below_minimum_power(battery)
    assert not CRCAP_LIMITS.below_minimum_power(HourlyBattery.sized(30.0))
    assert solve_contracted(hourly(TWO_PEAKS), battery).value > 0


# --- The contract limits -----------------------------------------------------------------


@pytest.mark.parametrize("seed", range(5))
@pytest.mark.parametrize("hours", [4.0, 8.0])
def test_the_daily_cycle_limit_holds(seed: int, hours: float) -> None:
    battery = HourlyBattery.sized(1.0, hours=hours)
    solution = solve_contracted(seeded_prices(6, seed), battery)
    assert_physical(solution, battery)

    kappa = CRCAP_LIMITS.contract_cycles_per_physical(battery)
    delivered = pd.Series(
        battery.discharge_efficiency * solution.discharge_mw, index=solution.index
    )
    by_day = delivered.groupby(solution.index.normalize()).sum() / (4 * battery.power_mw)
    assert by_day.max() <= 2 + 1e-6
    np.testing.assert_allclose(
        by_day.cumsum().to_numpy(),
        kappa * solution.cycles[HOURS_PER_DAY - 1 :: HOURS_PER_DAY],
    )


def test_the_daily_limit_bites_where_the_merchant_case_exceeds_it() -> None:
    """Three separated peaks in one day: the merchant case takes all three."""
    day = [40.0] * 4 + [300.0] * 2 + [40.0] * 4 + [300.0] * 2 + [40.0] * 4 + [300.0] * 2
    prices = hourly(day + [40.0] * 6)
    battery = replace(HourlyBattery.sized(1.0), max_charge_mw=3.0, max_discharge_mw=3.0)
    merchant = solve_hourly(prices, battery)
    contracted = solve_contracted(prices, battery)
    delivered = battery.discharge_efficiency * contracted.discharge_mw.sum()
    assert battery.discharge_efficiency * merchant.discharge_mw.sum() > 8.0 + 1e-3
    assert delivered <= 8.0 + 1e-6
    assert contracted.value < merchant.value


def test_the_rolling_year_holds_for_every_window_and_binds() -> None:
    """A price shape worth two cycles a day, against a tightened yearly limit."""
    limits = replace(CRCAP_LIMITS, cycles_per_year=20.0)
    days = 400
    prices = seeded_prices(days, 7)
    battery = HourlyBattery.sized(1.0)
    solution = solve_contracted(prices, battery, limits)

    kappa = limits.contract_cycles_per_physical(battery)
    count = kappa * np.concatenate([[0.0], solution.cycles])
    windows = count[HOURS_PER_YEAR:] - count[:-HOURS_PER_YEAR]
    assert windows.max() <= 20.0 + 1e-5
    assert windows.max() == pytest.approx(20.0, abs=1e-3)


def test_a_horizon_shorter_than_a_year_is_held_to_the_yearly_limit() -> None:
    limits = replace(CRCAP_LIMITS, cycles_per_year=3.0)
    battery = HourlyBattery.sized(1.0)
    solution = solve_contracted(seeded_prices(10, 3), battery, limits)
    kappa = limits.contract_cycles_per_physical(battery)
    assert kappa * solution.cycles[-1] <= 3.0 + 1e-6
    assert kappa * solution.cycles[-1] == pytest.approx(3.0, abs=1e-4)


def test_a_cycle_counts_delivered_energy_for_an_oversized_battery() -> None:
    """Double the volume: one physical cycle is two contractual cycles (kappa = 2)."""
    battery = HourlyBattery.sized(1.0, hours=8.0)
    assert CRCAP_LIMITS.contract_cycles_per_physical(battery) == pytest.approx(2.0)
    solution = solve_contracted(seeded_prices(3, 1), battery)
    by_day = pd.Series(solution.discharge_mw, index=solution.index)
    delivered = battery.discharge_efficiency * by_day.groupby(solution.index.normalize()).sum()
    assert delivered.max() <= 2 * 4 * battery.power_mw + 1e-6


def spiky_limits(hours: int) -> ContractLimits:
    return replace(CRCAP_LIMITS, injection_hours_per_day=hours)


@pytest.mark.usefixtures("exact_milp")
@pytest.mark.parametrize("seed", range(4))
def test_the_milp_equals_the_relaxation_when_the_hours_do_not_bind(seed: int) -> None:
    prices = seeded_prices(5, seed)
    battery = HourlyBattery.sized(1.0)
    relaxed = solve_hourly(prices, battery, limits=CRCAP_LIMITS)
    assert relaxed.injection_hours(battery.max_discharge_mw).max() <= 12

    every_day = frozenset(pd.DatetimeIndex(prices.index).normalize().unique())
    full = solve_hourly(prices, battery, limits=CRCAP_LIMITS, binary_days=every_day)
    solved = solve_contracted(prices, battery)
    assert solved.method == "lp-relaxation"
    assert solved.milp_rounds == 0
    assert solved.value == pytest.approx(relaxed.value, rel=1e-9)
    assert solved.value == pytest.approx(full.value, rel=1e-6)


@pytest.mark.parametrize("seed", range(4))
@pytest.mark.parametrize("limit", [2, 3])
def test_the_injection_limit_holds_when_it_binds(seed: int, limit: int) -> None:
    prices = seeded_prices(4, seed)
    battery = HourlyBattery.sized(1.0)
    limits = spiky_limits(limit)
    relaxed = solve_hourly(prices, battery, limits=limits)
    assert relaxed.injection_hours(battery.max_discharge_mw).max() > limit

    solved = solve_contracted(prices, battery, limits)
    assert solved.method == "milp"
    assert solved.injection_hours(battery.max_discharge_mw).max() <= limit
    assert solved.value < relaxed.value
    assert_physical(solved, battery)


@pytest.mark.usefixtures("exact_milp")
@pytest.mark.parametrize("seed", range(4))
def test_adding_binaries_lazily_reaches_the_full_milp(seed: int) -> None:
    prices = seeded_prices(4, seed)
    battery = HourlyBattery.sized(1.0)
    limits = spiky_limits(3)
    every_day = frozenset(pd.DatetimeIndex(prices.index).normalize().unique())
    full = solve_hourly(prices, battery, limits=limits, binary_days=every_day)
    assert solve_contracted(prices, battery, limits).value == pytest.approx(full.value, rel=1e-6)


def test_a_time_limit_is_reported_and_never_returned_as_a_plan() -> None:
    with pytest.raises(TimeoutError):
        solve_contracted(seeded_prices(3, 0), HourlyBattery.sized(1.0), time_limit=-1.0)
