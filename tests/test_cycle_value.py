"""The cycle-budget searches against what each method claims to deliver (§6).

The three-day instance below is the one from ``test_rolling_horizon.py``: two modest
days and then a dear one, with a single cycle to spend. The dear day sits beyond
the lookahead, so an uncharged run spends the budget early and a charged one
saves it — which makes the budget bind, and a binding budget is the only case
where a search has anything to find.
"""

from __future__ import annotations

from dataclasses import replace

import pulp
import pytest

from battery_plan.modelling.constraints import (
    DEFAULT_BLOCKS,
    UNCAPPED_BLOCKS,
    cycle_life_cap,
    energy_balance,
    relaxing,
)
from battery_plan.modelling.cycle_value.bisection import BisectionSearch
from battery_plan.modelling.cycle_value.calibrated_policy import CalibratedPolicy
from battery_plan.modelling.cycle_value.cutting_plane import (
    CuttingPlaneSearch,
    best_evaluation,
    solve_master,
)
from battery_plan.modelling.cycle_value.oracle import STOPPED_FOR_TIME, CycleOracle, DualPoint
from battery_plan.modelling.cycle_value.searches import SEARCHES, search_named
from battery_plan.modelling.parameters import ModelParameters
from battery_plan.modelling.periods import SettlementPeriods
from battery_plan.modelling.rolling_horizon import RollingPolicy, WindowProgress
from battery_plan.modelling.window_problem import build_problem, default_solver
from tests.helpers import SPEC, TOLERANCE, assert_feasible, make_periods

#: The whole budget of the instance below, in equivalent full cycles.
BUDGET = 1.0

#: What the dear day alone pays for that one cycle (§6), solved exactly below.
BEST_PROFIT = 1435.79


def _grid() -> SettlementPeriods:
    cheap = [20.0] * 24
    return make_periods(cheap + [100.0] * 24 + cheap + [100.0] * 24 + cheap + [400.0] * 24)


def _params() -> ModelParameters:
    return replace(ModelParameters.from_spec(SPEC), cycle_budget=BUDGET)


def _oracle() -> CycleOracle:
    return CycleOracle(settlement=_grid(), params=_params())


def _point(cycle_value: float, lagrangian: float, subgradient: float) -> DualPoint:
    """A cut, with the fields the master does not read left at zero."""
    return DualPoint(
        cycle_value=cycle_value,
        lagrangian=lagrangian,
        subgradient=subgradient,
        profit=0.0,
        cycles=0.0,
        plan=None,  # type: ignore[arg-type]
        relaxed=True,
        within_budget=False,
    )


def test_the_relaxed_pass_really_overspends_the_budget() -> None:
    """§6. Valuing a constraint means removing it: a value of zero must leave
    the horizon free to spend every cycle it can, not clip it at the budget."""
    oracle = _oracle()

    relaxed = oracle.at(0.0, relaxed=True)
    capped = oracle.at(0.0, relaxed=False)

    assert relaxed.cycles == pytest.approx(3.0, abs=1e-3)
    assert relaxed.cycles > capped.cycles
    assert capped.cycles == pytest.approx(BUDGET, rel=1e-4)
    assert not relaxed.within_budget
    assert capped.within_budget


def test_only_the_relaxed_pass_carries_a_usable_subgradient() -> None:
    """§6. The capped subproblem reports the same clipped count at every charge,
    so its subgradient is zero wherever the budget binds and says nothing."""
    oracle = _oracle()

    for cycle_value in (0.0, 100.0):
        assert oracle.at(cycle_value, relaxed=False).subgradient == pytest.approx(0.0, abs=1e-3)
        assert oracle.at(cycle_value, relaxed=True).subgradient == pytest.approx(-2.0, abs=1e-3)

    # And at the value that rations the budget exactly, the relaxed slope is zero.
    assert oracle.at(300.0, relaxed=True).subgradient == pytest.approx(0.0, abs=1e-3)


def test_the_oracle_counts_and_reuses_its_passes() -> None:
    """A pass is the unit of cost, so it is counted once and never repeated."""
    oracle = _oracle()

    first = oracle.at(0.0, relaxed=True)
    again = oracle.at(0.0, relaxed=True)
    capped = oracle.at(0.0, relaxed=False)

    assert again is first
    assert capped is not first
    assert oracle.passes == 2


def test_relaxing_builds_a_model_without_the_valued_constraint() -> None:
    assert relaxing(cycle_life_cap) == UNCAPPED_BLOCKS
    assert cycle_life_cap not in UNCAPPED_BLOCKS
    assert len(UNCAPPED_BLOCKS) == len(DEFAULT_BLOCKS) - 1
    assert set(relaxing(cycle_life_cap, energy_balance)) == set(DEFAULT_BLOCKS) - {
        cycle_life_cap,
        energy_balance,
    }


def test_relaxing_rejects_a_block_that_is_not_in_the_model() -> None:
    """A typo must not silently relax nothing."""

    def not_a_constraint(problem: pulp.LpProblem, ctx: object) -> None: ...  # pragma: no cover

    with pytest.raises(ValueError, match="not_a_constraint"):
        relaxing(not_a_constraint)


def test_the_master_minimises_the_envelope_of_its_cuts() -> None:
    """Two cuts crossing at λ = 10: the envelope's minimum is the crossing."""
    falling = _point(cycle_value=0.0, lagrangian=100.0, subgradient=-2.0)  # L >= 100 - 2 λ
    rising = _point(cycle_value=0.0, lagrangian=60.0, subgradient=+2.0)  # L >= 60 + 2 λ

    envelope, cycle_value = solve_master([falling, rising], upper_bound=1_000.0)

    assert cycle_value == pytest.approx(10.0)
    assert envelope == pytest.approx(80.0)


def test_the_master_stays_inside_its_box() -> None:
    """A single falling cut would send λ to infinity; the box is what stops it."""
    _, cycle_value = solve_master([_point(0.0, 100.0, -2.0)], upper_bound=50.0)

    assert cycle_value == pytest.approx(50.0)


def test_a_pass_beaten_at_its_own_value_does_not_make_the_gap_negative() -> None:
    """A rolling pass is not an exact maximiser, so another pass's plan can do
    better at its λ. Here the pass at λ = 4 reports L = 5 while the plan from
    λ = 0 earns 10 - 4 = 6 there. Reading the bound as min L would give 5,
    below the master's envelope minimum of 5.5: a negative gap, and a "bound"
    a known plan beats. The bound is the cuts' envelope at each evaluated λ."""
    cuts = [_point(0.0, 10.0, -1.0), _point(4.0, 5.0, 1.0)]
    envelope, _ = solve_master(cuts, upper_bound=50.0)

    best, bound = best_evaluation(cuts)

    assert envelope == pytest.approx(5.5)
    assert min(cut.lagrangian for cut in cuts) < envelope  # the old reading
    assert best.cycle_value == 4.0
    assert bound == pytest.approx(6.0)
    assert bound >= envelope


def test_both_methods_find_the_schedule_that_spends_the_cycle_best() -> None:
    """§6. The methods differ in passes and in the cycle value they report, not in
    the dispatch: the deliverable is the dear day, bought cheap and sold at 400."""
    results = {
        name: search.search(_oracle())
        for name, search in (
            ("bisection", BisectionSearch(upper_bound=5_000.0)),
            ("cutting-plane", CuttingPlaneSearch()),
        )
    }

    for name, result in results.items():
        assert result.profit == pytest.approx(BEST_PROFIT, abs=0.01), name
        assert result.cycles <= BUDGET + TOLERANCE, name
        assert_feasible(result.plan, _params())


def test_bisection_spends_a_fixed_number_of_passes_and_certifies_nothing() -> None:
    result = BisectionSearch(upper_bound=5_000.0, max_iterations=12).search(_oracle())

    assert result.passes == 13
    assert result.bound is None
    assert result.cycle_value > BEST_PROFIT / 2  # the top of the plateau, not a shadow price


def test_cutting_planes_close_their_gap_in_fewer_passes_and_report_a_bound() -> None:
    result = CuttingPlaneSearch().search(_oracle())

    assert result.passes < 13
    assert result.bound is not None
    assert result.bound.relative_gap <= CuttingPlaneSearch().tolerance
    assert result.bound.gap >= -TOLERANCE


def test_the_dual_bound_is_not_below_the_exact_optimum() -> None:
    """§6 weak duality, which is the whole claim the bound makes. The instance is
    small enough to solve whole, as one capped MILP, so the claim is checkable."""
    settlement, params = _grid(), _params()
    problem, _ = build_problem(settlement, params)
    problem.solve(default_solver())
    objective = pulp.value(problem.objective)
    assert objective is not None
    exact = float(objective)

    result = CuttingPlaneSearch().search(CycleOracle(settlement=settlement, params=params))

    assert result.bound is not None
    assert result.bound.lagrangian >= exact - TOLERANCE
    assert result.profit <= exact + TOLERANCE


def test_an_ample_budget_costs_one_pass_under_either_method() -> None:
    """§6. With the budget of §5 the cap never binds, so there is nothing to
    search for: the first pass says so and both methods stop."""
    settlement = _grid()
    params = ModelParameters.from_spec(SPEC)  # the full 5,000 cycles

    for name, search in SEARCHES.items():
        result = search.search(CycleOracle(settlement=settlement, params=params))
        assert result.cycle_value == 0.0, name
        assert result.passes == 1, name
        assert result.cycles < params.cycle_budget, name


def test_a_calibrated_dispatcher_is_a_dispatcher() -> None:
    """The seam downstream does not change: prices in, plan out."""
    policy = CalibratedPolicy(search=search_named("cutting-plane"))
    result = policy.calibrate_and_dispatch(_grid(), _params())

    assert result.profit == pytest.approx(BEST_PROFIT, abs=0.01)
    assert list(result.plan.columns) == list(
        CalibratedPolicy().calibrate_and_dispatch(_grid(), _params()).plan.columns
    )


class _Clock:
    """A clock that only moves when a window is solved: ten seconds a window."""

    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now

    def window(self, progress: WindowProgress) -> None:
        self.now += 10.0


def _timed_oracle(deadline: float | None) -> tuple[CycleOracle, _Clock]:
    """The instance above on the fake clock: three windows, so 30 s a pass."""
    clock = _Clock()
    oracle = CycleOracle(
        settlement=_grid(),
        params=_params(),
        policy=RollingPolicy(on_window=clock.window),
        deadline=deadline,
        clock=clock,
    )
    return oracle, clock


def test_a_deadline_stops_the_search_and_still_recovers_a_plan_within_budget() -> None:
    """After one 30 s pass, 70 s are left: short of 1.5 x (pass + recovery) = 90 s.
    So the search stops, recovers a capped plan at its best value, and finishes
    inside the deadline with a bound that says how far from optimal it may be."""
    oracle, clock = _timed_oracle(deadline=100.0)

    result = CuttingPlaneSearch().search(oracle)

    assert result.stopped_early and result.stop_reason == STOPPED_FOR_TIME
    assert result.passes == 2  # one relaxed pass, then the recovery
    assert not oracle.points[0].within_budget and not oracle.points[1].relaxed
    assert clock.now <= 100.0
    assert result.cycles <= BUDGET + TOLERANCE
    assert_feasible(result.plan, _params())
    assert result.bound is not None
    assert result.bound.lagrangian >= result.profit - TOLERANCE
    assert result.profit < BEST_PROFIT


def test_a_deadline_with_room_to_spare_changes_nothing() -> None:
    oracle, _ = _timed_oracle(deadline=10_000.0)
    timed = CuttingPlaneSearch().search(oracle)
    free = CuttingPlaneSearch().search(_oracle())

    assert not timed.stopped_early and timed.stop_reason is None
    assert (timed.passes, timed.profit, timed.cycle_value) == pytest.approx(
        (free.passes, free.profit, free.cycle_value)
    )


def test_bisection_under_a_deadline_returns_its_best_capped_plan() -> None:
    oracle, clock = _timed_oracle(deadline=100.0)

    result = BisectionSearch(upper_bound=5_000.0).search(oracle)

    assert result.stopped_early
    assert result.passes == 2  # 30 s each, and 45 s needed for a third
    assert clock.now <= 100.0
    assert result.cycles <= BUDGET + TOLERANCE


def test_an_unknown_method_names_the_ones_there_are() -> None:
    with pytest.raises(KeyError, match="cutting-plane"):
        search_named("gradient-descent")
