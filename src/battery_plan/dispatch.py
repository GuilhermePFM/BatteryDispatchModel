"""A calibrated dispatch as one call: inputs in memory, plan out.

:func:`run_dispatch` is the run the ``dispatch`` command makes, without the
files on either side of it. It takes a :class:`BatterySpec` and
:class:`MarketPrices` that are already loaded — from the spreadsheets, an
uploaded CSV or a test — and returns the plan with the search that produced
it, so the CLI and a job runner share one code path and differ only in where
the inputs come from and where the plan goes.

Progress goes out through the reporter seam of :mod:`battery_plan.reporting`:
a terminal passes a ``reporter``, a job passes ``on_progress`` and receives a
:class:`~battery_plan.reporting.ProgressEvent` per change, and either may be
left out.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass

import pandas as pd

from battery_plan.data_io.quality import price_quality_report
from battery_plan.data_models import BatterySpec, MarketPrices
from battery_plan.modelling import ModelParameters, RollingPolicy, build_periods
from battery_plan.modelling.cycle_value.calibrated_policy import CalibratedPolicy
from battery_plan.modelling.cycle_value.oracle import CycleOracle, DualSearchResult
from battery_plan.modelling.cycle_value.searches import DEFAULT_SEARCH, search_named
from battery_plan.modelling.rolling_horizon import PERIODS_PER_DAY
from battery_plan.reporting import (
    CallbackReporter,
    NullReporter,
    ProgressEvent,
    Reporter,
    RunPlan,
)


@dataclass(frozen=True, slots=True)
class DispatchConfig:
    """What to dispatch over, and how — everything but the battery and the prices.

    ``start`` and ``end`` bound the horizon, and ``end`` without a time of day
    includes the whole of that day, as ``--end`` does. ``None`` on either side
    means the edge of the data. ``cycle_budget`` defaults to the battery's
    cycle life, per §5.
    """

    start: str | pd.Timestamp | None = None
    end: str | pd.Timestamp | None = None
    commit_days: int = 1
    lookahead_days: int = 1
    search: str = DEFAULT_SEARCH
    cycle_budget: float | None = None


@dataclass(frozen=True, slots=True)
class DispatchResult:
    """The plan, the search that found it, and the parameters it was solved at."""

    search: DualSearchResult
    params: ModelParameters
    elapsed: float

    @property
    def plan(self) -> pd.DataFrame:
        return self.search.plan


class DispatchInterrupted(KeyboardInterrupt):
    """A run stopped by the user, carrying the passes it had already paid for.

    Still a :class:`KeyboardInterrupt`, so a caller that does not care stops
    as before; one that does can write the best plan in ``oracle``.
    """

    def __init__(self, oracle: CycleOracle, params: ModelParameters) -> None:
        super().__init__()
        self.oracle = oracle
        self.params = params


def run_dispatch(
    spec: BatterySpec,
    prices: MarketPrices,
    config: DispatchConfig,
    on_progress: Callable[[ProgressEvent], None] | None = None,
    *,
    reporter: Reporter | None = None,
    out_path: str = "",
    started: float | None = None,
) -> DispatchResult:
    """Value the cycle budget over the configured horizon, and dispatch at that value.

    ``reporter`` renders the run (the CLI's console); ``on_progress`` receives
    it as flat events (a job's progress record). ``out_path`` is only what the
    run announces as its destination — nothing is written here. ``started`` is
    a :func:`time.perf_counter` reading from before the inputs were loaded, so
    the ``inputs`` phase and the run's total can include the loading.
    """
    started = time.perf_counter() if started is None else started
    reporter = reporter if reporter is not None else NullReporter()
    if on_progress is not None:
        reporter = CallbackReporter(on_progress, inner=reporter)

    quality = price_quality_report(prices)
    params = ModelParameters.from_spec(spec, cycle_budget=config.cycle_budget)
    settlement = build_periods(prices).between(config.start, _end_of_day(config.end))
    if len(settlement) == 0:
        raise ValueError(f"no prices between {config.start} and {config.end}")
    policy = RollingPolicy(
        commit_periods=config.commit_days * PERIODS_PER_DAY,
        lookahead_periods=config.lookahead_days * PERIODS_PER_DAY,
    )

    reporter.run_started(
        RunPlan(
            start=settlement.timestamps[0],
            end=settlement.timestamps[-1],
            periods=len(settlement),
            period_minutes=params.dt * 60.0,
            windows=policy.window_count(len(settlement)),
            commit_periods=policy.commit_periods,
            lookahead_periods=policy.lookahead_periods,
            power_mw=params.max_discharge_mw,
            volume_mwh=params.nominal_volume_mwh,
            round_trip_efficiency=params.round_trip_efficiency,
            cycle_budget=params.cycle_budget,
            out_path=out_path,
        )
    )
    reporter.phase(
        "inputs",
        "done",
        f"spec + 2 price series · {int(quality['duplicate_timestamps'].sum())} duplicates "
        f"· {int(quality['missing_prices'].sum())} missing prices",
        elapsed=time.perf_counter() - started,
    )
    reporter.phase(
        "horizon",
        "done",
        f"{len(settlement):,} periods → {policy.window_count(len(settlement)):,} windows",
    )

    calibrated = CalibratedPolicy(
        search=search_named(config.search), policy=policy, reporter=reporter
    )
    oracle = calibrated.oracle_for(settlement, params)
    try:
        result = calibrated.calibrate_and_dispatch(settlement, params, oracle=oracle)
    except KeyboardInterrupt as stop:
        raise DispatchInterrupted(oracle, params) from stop

    elapsed = time.perf_counter() - started
    reporter.run_finished(elapsed, result.passes)
    return DispatchResult(search=result, params=params, elapsed=elapsed)


def _end_of_day(value: str | pd.Timestamp | None) -> pd.Timestamp | None:
    """Read ``end`` as inclusive of the whole day when no time is given."""
    if value is None:
        return None
    end = pd.Timestamp(value)
    return end + pd.Timedelta(days=1) if end.normalize() == end else end
