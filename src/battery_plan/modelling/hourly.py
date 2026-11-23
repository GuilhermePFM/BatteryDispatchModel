"""The hourly dispatch of one battery in one PLD submarket (§2 to §6 of the model note).

One program covers the whole horizon. The merchant case is a linear program:
§5.1 proves that with positive prices and a real loss no optimal plan charges
and discharges in the same hour, so no binary keeps them apart, and
:func:`net_flows` settles the ties that a zero-loss battery can leave.

The contracted case adds the CRCAP limits of §4.5. Its 12 h injection limit is
the only binary of the model, and :func:`solve_contracted` avoids it whenever it
can: the program without the binary is a relaxation, so a relaxed plan that
already respects the limit is optimal. Otherwise only the days that break the
limit receive binaries, and the days are added until none breaks it.
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass, field

import numpy as np
import pandas as pd
import pulp

#: Length of a PLD settlement period, in hours (§2, ``dt``).
HOURLY_DT = 1.0

#: Hourly periods in a calendar day, derived so that a day is never a stray literal.
HOURS_PER_DAY = round(24 / HOURLY_DT)

#: Hours in the rolling 12-month window of the cycle limit (§4.5).
HOURS_PER_YEAR = 365 * HOURS_PER_DAY

#: Below this share of the discharge rate an hour does not count as injecting.
#: It sits above HiGHS's integrality tolerance of 1e-6: a binary at that distance
#: from zero lets ``d <= D z`` leak up to 1e-6 of the rate.
INJECTION_TOLERANCE = 1e-5

#: Relative optimality gap of the contracted MILP, 0.1%. The value of case C is a
#: proxy for the ONS dispatch and not revenue (§3), and on forced binding cases a
#: gap of 0.01% no longer finished inside the time a Lambda has (docs/solve.md).
MILP_GAP = 1e-3


@dataclass(frozen=True, slots=True)
class HourlyBattery:
    """The physical battery of §2, in MW and MWh.

    ``power_mw`` is delivered to the grid. ``max_charge_mw`` is measured on the
    grid side and ``max_discharge_mw`` on the storage side, as in §2.
    """

    power_mw: float
    volume_mwh: float
    max_charge_mw: float
    max_discharge_mw: float
    charge_efficiency: float
    discharge_efficiency: float
    degradation_per_cycle: float = 1e-5
    cycle_budget: float | None = None

    def __post_init__(self) -> None:
        if min(self.power_mw, self.volume_mwh, self.max_charge_mw, self.max_discharge_mw) <= 0:
            raise ValueError("power, volume and rates must be positive")
        for efficiency in (self.charge_efficiency, self.discharge_efficiency):
            if not 0 < efficiency <= 1:
                raise ValueError("efficiencies must be in (0, 1]")
        if not 0 <= self.degradation_per_cycle < 1:
            raise ValueError("degradation per cycle must be in [0, 1)")
        if self.cycle_budget is not None and self.cycle_budget < 0:
            raise ValueError("the cycle budget cannot be negative")

    @classmethod
    def sized(
        cls,
        power_mw: float,
        *,
        hours: float = 4.0,
        round_trip_efficiency: float = 0.85,
        recharge_hours: float = 6.0,
        degradation_per_cycle: float = 1e-5,
        cycle_budget: float | None = None,
    ) -> HourlyBattery:
        """The §2 defaults: ``hours`` delivered at ``power_mw``, recharged in ``recharge_hours``."""
        if not 0 < round_trip_efficiency <= 1:
            raise ValueError("round-trip efficiency must be in (0, 1]")
        if hours <= 0 or recharge_hours <= 0:
            raise ValueError("durations must be positive")
        one_way = math.sqrt(round_trip_efficiency)
        volume = hours * power_mw / one_way
        return cls(
            power_mw=power_mw,
            volume_mwh=volume,
            max_charge_mw=volume / (recharge_hours * one_way),
            max_discharge_mw=power_mw / one_way,
            charge_efficiency=one_way,
            discharge_efficiency=one_way,
            degradation_per_cycle=degradation_per_cycle,
            cycle_budget=cycle_budget,
        )

    @property
    def round_trip_efficiency(self) -> float:
        """``eta_c * eta_d`` (§4.2)."""
        return self.charge_efficiency * self.discharge_efficiency


@dataclass(frozen=True, slots=True)
class ContractLimits:
    """The dispatch limits of the capacity contract (CRCAP 5.1.1, Annex I of the Editais).

    ``cycle_hours`` is the delivered energy of one CICLO COMPLETO, in hours at
    the contracted power (Appendix III). The 12-month window is read as rolling,
    the conservative reading of "a cada 12 (doze) meses" in 5.1.1(ii).
    """

    cycle_hours: float = 4.0  # 5.1.1(ii)
    cycles_per_day: float = 2.0  # 5.1.1(ii)
    cycles_per_year: float = 366.0  # 5.1.1(ii), 5.1.2
    injection_hours_per_day: int = 12  # 5.1.1(iii)
    recharge_hours: float = 6.0  # 5.1.1(vii)
    minimum_round_trip: float = 0.85  # 8.1, Portaria 136 art. 7 VI
    minimum_power_mw: float = 30.0  # Portaria 136 art. 7 III

    def contract_cycles_per_physical(self, battery: HourlyBattery) -> float:
        """``kappa`` of §2: contractual full cycles delivered by one physical full cycle."""
        delivered = battery.discharge_efficiency * battery.volume_mwh
        return delivered / (self.cycle_hours * battery.power_mw)

    def sizing_shortfalls(self, battery: HourlyBattery) -> tuple[str, ...]:
        """The static obligations of §4.5 that this battery cannot meet."""
        margin = 1e-9
        shortfalls = []
        if battery.discharge_efficiency * battery.volume_mwh < (
            self.cycle_hours * battery.power_mw * (1 - margin)
        ):
            shortfalls.append(f"delivers less than {self.cycle_hours:g} h at contracted power")
        if battery.max_discharge_mw * battery.discharge_efficiency < (
            battery.power_mw * (1 - margin)
        ):
            shortfalls.append("discharge rate is below the contracted power")
        # 5.1.1(vii) measures the recharge on the contracted storage, power times
        # 4 h (Appendix III), so a larger battery needs no faster charger.
        contracted_stored = self.cycle_hours * battery.power_mw / battery.discharge_efficiency
        if battery.max_charge_mw * battery.charge_efficiency < (
            contracted_stored / self.recharge_hours * (1 - margin)
        ):
            shortfalls.append(
                f"cannot recharge the contracted {self.cycle_hours:g} h"
                f" within {self.recharge_hours:g} h"
            )
        if battery.round_trip_efficiency < self.minimum_round_trip * (1 - margin):
            shortfalls.append(f"round-trip efficiency is below {self.minimum_round_trip:.0%}")
        return tuple(shortfalls)

    def below_minimum_power(self, battery: HourlyBattery) -> bool:
        """Under the auction's minimum: a warning, since the project can still be studied."""
        return battery.power_mw < self.minimum_power_mw


#: The limits of the 2026 auction contract.
CRCAP_LIMITS = ContractLimits()


@dataclass(frozen=True, slots=True)
class HourlyState:
    """Store and cycle count carried into the first hour. The battery starts empty (§5)."""

    storage_mwh: float = 0.0
    cycles: float = 0.0


@dataclass(frozen=True, slots=True)
class HourlySolution:
    """An hourly plan, after netting, and how it was obtained."""

    index: pd.DatetimeIndex
    prices: np.ndarray
    charge_mw: np.ndarray
    discharge_mw: np.ndarray
    storage_mwh: np.ndarray
    cycles: np.ndarray
    discharge_efficiency: float
    method: str
    solve_seconds: float
    binary_days: int = 0
    milp_rounds: int = 0
    notes: tuple[str, ...] = field(default=())

    def __len__(self) -> int:
        return len(self.index)

    @property
    def hourly_value(self) -> np.ndarray:
        """The §3 objective of each hour, in BRL."""
        net_mw = self.discharge_efficiency * self.discharge_mw - self.charge_mw
        return np.asarray(self.prices * net_mw * HOURLY_DT, dtype=float)

    @property
    def value(self) -> float:
        """The §3 objective over the horizon, in BRL."""
        return float(self.hourly_value.sum())

    @property
    def daily_value(self) -> pd.Series:
        """The §3 objective of each calendar day, in BRL."""
        series = pd.Series(self.hourly_value, index=self.index)
        return series.groupby(self.index.normalize()).sum()

    def injection_hours(self, max_discharge_mw: float) -> pd.Series:
        """Hours of each day in which the battery injects, as §4.5 counts them."""
        injecting = self.discharge_mw > INJECTION_TOLERANCE * max_discharge_mw
        return pd.Series(injecting, index=self.index).groupby(self.index.normalize()).sum()


def hourly_series(prices: pd.Series) -> pd.Series:
    """Check that a price series is what the program assumes, and return it as floats.

    Hours are local market time, so an index with a timezone is refused rather
    than converted: converting would move the daily price shape.
    """
    if not isinstance(prices.index, pd.DatetimeIndex):
        raise ValueError("prices need a DatetimeIndex")
    if prices.index.tz is not None:
        raise ValueError("prices must be in local market time, with no UTC offset")
    if len(prices) == 0:
        raise ValueError("no prices to dispatch against")
    steps = np.diff(prices.index.to_numpy())
    if len(steps) and not (steps == np.timedelta64(round(HOURLY_DT), "h")).all():
        raise ValueError("prices must be consecutive hours with no gaps or repeats")
    values = prices.to_numpy(dtype=float)
    if not np.isfinite(values).all() or (values <= 0).any():
        raise ValueError("prices must be finite and above zero (§5.1)")
    return pd.Series(values, index=prices.index, name=prices.name)


def slice_days(
    prices: pd.Series,
    start: str | pd.Timestamp | None = None,
    end: str | pd.Timestamp | None = None,
) -> pd.Series:
    """The whole days from ``start`` to ``end``, both inclusive.

    The upper edge is open at the next midnight: an inclusive edge there would
    add a 25th hour to the last day.
    """
    index = prices.index
    low = index[0] if start is None else pd.Timestamp(start).normalize()
    high = index[-1] + pd.Timedelta(hours=1)
    if end is not None:
        high = pd.Timestamp(end).normalize() + pd.Timedelta(days=1)
    selected: pd.Series = prices.loc[(index >= low) & (index < high)]
    return selected


def net_flows(
    charge: np.ndarray, discharge: np.ndarray, charge_efficiency: float
) -> tuple[np.ndarray, np.ndarray]:
    """The substitution of §5.1, which removes simultaneous flows at no loss of value.

    It leaves ``eta_c * c - d`` unchanged, so the storage path does not move.
    """
    overlap = np.minimum(charge, discharge / charge_efficiency)
    return (
        np.maximum(charge - overlap, 0.0),
        np.maximum(discharge - charge_efficiency * overlap, 0.0),
    )


def solve_hourly(
    prices: pd.Series,
    battery: HourlyBattery,
    *,
    limits: ContractLimits | None = None,
    binary_days: frozenset[pd.Timestamp] = frozenset(),
    state: HourlyState | None = None,
    solver: pulp.LpSolver | None = None,
    time_limit: float | None = None,
) -> HourlySolution:
    """Solve one program over the horizon.

    With ``limits=None`` it is the merchant LP. With limits it holds the cycle
    rows of §4.5, and the 12 h rows only on ``binary_days``, which is how
    :func:`solve_contracted` builds its relaxations.
    """
    series = hourly_series(prices)
    opening = state if state is not None else HourlyState()
    problem, charge, discharge, storage, _ = _build_program(
        series, battery, limits, binary_days, opening
    )

    started = time.perf_counter()
    stats = problem.solve(solver or _solver(mip=bool(binary_days), time_limit=time_limit))
    elapsed = time.perf_counter() - started
    if stats.status is pulp.LpSolveStatus.TimeLimit:
        raise TimeoutError(f"hourly program from {series.index[0]} hit its time limit")
    if stats.status is not pulp.LpSolveStatus.Optimal:
        raise RuntimeError(f"hourly program from {series.index[0]} solved as {stats.status.name}")

    netted_charge, netted_discharge = net_flows(
        _values(charge), _values(discharge), battery.charge_efficiency
    )
    # Netting lowers the discharge, so the count is rebuilt from what remains (§4.6).
    counted = opening.cycles + np.cumsum(netted_discharge) * HOURLY_DT / battery.volume_mwh
    return HourlySolution(
        index=pd.DatetimeIndex(series.index),
        prices=series.to_numpy(),
        charge_mw=netted_charge,
        discharge_mw=netted_discharge,
        storage_mwh=_values(storage),
        cycles=counted,
        discharge_efficiency=battery.discharge_efficiency,
        method="milp" if binary_days else "lp",
        solve_seconds=elapsed,
        binary_days=len(binary_days),
    )


def solve_contracted(
    prices: pd.Series,
    battery: HourlyBattery,
    limits: ContractLimits = CRCAP_LIMITS,
    *,
    time_limit: float | None = None,
) -> HourlySolution:
    """The contracted case of §6: the relaxation first, binaries only where they matter.

    Every program solved here drops the 12 h rows of some days, so each is a
    relaxation of the full MILP. The first one whose plan respects the limit on
    every day is therefore optimal for it. Days that break the limit gain their
    binaries and stay, so the loop ends after at most one round per day.

    ``time_limit`` covers the whole call, across all rounds.
    """
    shortfalls = limits.sizing_shortfalls(battery)
    if shortfalls:
        raise ValueError(f"battery cannot meet the contract: {'; '.join(shortfalls)}")

    started = time.perf_counter()
    binary_days: set[pd.Timestamp] = set()
    rounds = 0
    while True:
        remaining = None if time_limit is None else time_limit - (time.perf_counter() - started)
        if remaining is not None and remaining <= 0:
            raise TimeoutError(f"contracted MILP exceeded {time_limit:g} s")
        solution = solve_hourly(
            prices,
            battery,
            limits=limits,
            binary_days=frozenset(binary_days),
            time_limit=remaining,
        )
        hours = solution.injection_hours(battery.max_discharge_mw)
        violated = set(hours.index[hours > limits.injection_hours_per_day])
        if not violated:
            elapsed = time.perf_counter() - started
            method = "lp-relaxation" if not binary_days else "milp"
            return _with_run(solution, method, elapsed, len(binary_days), rounds)
        if violated <= binary_days:
            raise RuntimeError(f"days over the limit despite their binaries: {sorted(violated)}")
        binary_days |= violated
        rounds += 1


def _with_run(
    solution: HourlySolution, method: str, elapsed: float, binary_days: int, rounds: int
) -> HourlySolution:
    return HourlySolution(
        index=solution.index,
        prices=solution.prices,
        charge_mw=solution.charge_mw,
        discharge_mw=solution.discharge_mw,
        storage_mwh=solution.storage_mwh,
        cycles=solution.cycles,
        discharge_efficiency=solution.discharge_efficiency,
        method=method,
        solve_seconds=elapsed,
        binary_days=binary_days,
        milp_rounds=rounds,
    )


def _build_program(
    prices: pd.Series,
    battery: HourlyBattery,
    limits: ContractLimits | None,
    binary_days: frozenset[pd.Timestamp],
    state: HourlyState,
) -> tuple[
    pulp.LpProblem,
    list[pulp.LpVariable],
    list[pulp.LpVariable],
    list[pulp.LpVariable],
    list[pulp.LpVariable],
]:
    """Assemble §3 and §4 over the hours of ``prices``."""
    periods = range(len(prices))
    values = prices.to_numpy()
    problem = pulp.LpProblem("hourly_dispatch", pulp.LpMaximize)
    charge = problem.add_variable_matrix("c", periods, 0, battery.max_charge_mw)
    discharge = problem.add_variable_matrix("d", periods, 0, battery.max_discharge_mw)
    storage = problem.add_variable_matrix("S", periods, 0, battery.volume_mwh)
    cycles = problem.add_variable_matrix("n", periods, 0)

    problem += pulp.lpSum(
        HOURLY_DT * float(values[t]) * (battery.discharge_efficiency * discharge[t] - charge[t])
        for t in periods
    )

    volume = battery.volume_mwh
    for t in periods:
        previous_storage = storage[t - 1] if t else state.storage_mwh
        previous_cycles = cycles[t - 1] if t else state.cycles
        problem += (
            storage[t]
            == previous_storage
            + HOURLY_DT * (battery.charge_efficiency * charge[t] - discharge[t]),
            f"balance_{t}",
        )
        problem += (
            cycles[t] == previous_cycles + HOURLY_DT * discharge[t] / volume,
            f"cycles_{t}",
        )
        problem += (
            storage[t] + volume * battery.degradation_per_cycle * cycles[t] <= volume,
            f"storage_bound_{t}",
        )

    if battery.cycle_budget is not None:
        problem += cycles[-1] <= battery.cycle_budget, "cycle_life"
    if limits is not None:
        _add_contract_rows(problem, prices, battery, limits, binary_days, discharge, cycles, state)
    return problem, charge, discharge, storage, cycles


def _add_contract_rows(
    problem: pulp.LpProblem,
    prices: pd.Series,
    battery: HourlyBattery,
    limits: ContractLimits,
    binary_days: frozenset[pd.Timestamp],
    discharge: list[pulp.LpVariable],
    cycles: list[pulp.LpVariable],
    state: HourlyState,
) -> None:
    """The cycle rows of §4.5, and the 12 h rows of the days in ``binary_days``."""
    kappa = limits.contract_cycles_per_physical(battery)
    days = pd.DatetimeIndex(prices.index).normalize()
    last_of_day = np.flatnonzero(np.append(days[1:] != days[:-1], True))

    before: pulp.LpVariable | float = state.cycles
    for position, last in enumerate(last_of_day):
        problem += kappa * (cycles[last] - before) <= limits.cycles_per_day, f"daily_{position}"
        before = cycles[last]

    # A horizon shorter than the window still fits inside one 12-month period.
    final = len(prices) - 1
    if final < HOURS_PER_YEAR - 1:
        problem += (
            kappa * (cycles[final] - state.cycles) <= limits.cycles_per_year,
            "yearly_short",
        )
    for t in range(HOURS_PER_YEAR - 1, len(prices)):
        earlier = cycles[t - HOURS_PER_YEAR] if t >= HOURS_PER_YEAR else state.cycles
        problem += kappa * (cycles[t] - earlier) <= limits.cycles_per_year, f"yearly_{t}"

    for day in sorted(binary_days):
        hours = np.flatnonzero(days == day)
        flags = problem.add_variable_matrix(f"z_{day:%Y%m%d}", range(len(hours)), cat="Binary")
        for hour, flag in zip(hours, flags, strict=True):
            problem += discharge[hour] <= battery.max_discharge_mw * flag, f"injecting_{hour}"
        problem += pulp.lpSum(flags) <= limits.injection_hours_per_day, f"hours_{day:%Y%m%d}"


def _solver(*, mip: bool, time_limit: float | None) -> pulp.LpSolver:
    """HiGHS at stock settings; a MILP also gets the gap the optimality claim rests on."""
    return pulp.HiGHS(msg=False, timeLimit=time_limit, gapRel=MILP_GAP if mip else None)


def _values(variables: list[pulp.LpVariable]) -> np.ndarray:
    return np.array([pulp.value(variable) for variable in variables], dtype=float)
