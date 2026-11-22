"""The dispatch as one call: the same run the CLI makes, without the files (§6)."""

from __future__ import annotations

import io
from dataclasses import replace
from pathlib import Path

import pandas as pd
import pytest

from battery_plan.cli import main
from battery_plan.data_io import load_market_prices, load_market_prices_csv, write_market_prices_csv
from battery_plan.data_io.paths import BATTERY_SPEC_XLSX, MARKET_PRICES_XLSX
from battery_plan.data_models import MarketPrices
from battery_plan.dispatch import DispatchConfig, run_dispatch
from battery_plan.reporting import ProgressEvent
from tests.helpers import SPEC, hourly_mean

requires_spreadsheets = pytest.mark.skipif(
    not (BATTERY_SPEC_XLSX.exists() and MARKET_PRICES_XLSX.exists()),
    reason="raw spreadsheets are not present",
)


@requires_spreadsheets
def test_run_dispatch_returns_the_plan_the_cli_writes(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    out = tmp_path / "plan.csv"
    argv = ["dispatch", "--start", "2018-02-01", "--end", "2018-02-04", "--out", str(out)]
    assert main([*argv, "--quiet"]) == 0
    capsys.readouterr()

    run = run_dispatch(
        SPEC, load_market_prices(), DispatchConfig(start="2018-02-01", end="2018-02-04")
    )
    written = pd.read_csv(out, index_col=0, parse_dates=True)

    assert len(run.plan) == 4 * 48
    pd.testing.assert_frame_equal(run.plan, written, check_freq=False, check_names=False)
    assert run.search.passes >= 1
    assert run.params.cycle_budget == SPEC.lifetime_cycles


def _prices(days: int) -> MarketPrices:
    """A cheap night and a dear evening, every day, with Market 2 the hourly mean."""
    day = [20.0] * 24 + [60.0] * 12 + [140.0] * 12
    half_hourly = day * days
    return MarketPrices(
        market_1=pd.Series(
            half_hourly, index=pd.date_range("2024-01-01", periods=len(half_hourly), freq="30min")
        ),
        market_2=pd.Series(
            hourly_mean(half_hourly),
            index=pd.date_range("2024-01-01", periods=len(half_hourly) // 2, freq="1h"),
        ),
    )


def test_on_progress_receives_a_run_that_only_moves_forward() -> None:
    events: list[ProgressEvent] = []
    run = run_dispatch(SPEC, _prices(3), DispatchConfig(), events.append)

    fractions = [event.fraction for event in events]
    assert fractions == sorted(fractions)
    assert all(0.0 <= fraction <= 1.0 for fraction in fractions)
    assert not any(event.done for event in events[:-1])

    last = events[-1]
    assert last.done and last.fraction == 1.0 and last.phase == "done"
    assert last.passes_estimated == run.search.passes
    assert {"inputs", "horizon", "calibrate"} <= {event.phase for event in events}
    assert [event.elapsed for event in events] == sorted(event.elapsed for event in events)


def test_a_binding_budget_reports_each_pass_and_its_cycle_value() -> None:
    """One cycle over three days binds, so the search spends several passes."""
    events: list[ProgressEvent] = []
    run = run_dispatch(SPEC, _prices(3), DispatchConfig(cycle_budget=1.0), events.append)

    assert run.params.cycle_budget == 1.0
    assert run.search.passes > 1
    assert float(run.plan["cycles"].iloc[-1]) <= 1.0 + 1e-6
    passes = {event.pass_index for event in events}
    assert passes == set(range(run.search.passes + 1))
    assert max(event.cycle_value for event in events) > 0.0
    assert events[-1].passes_max == 20
    # A finished pass is counted once: the bar is not at its end with passes still to go.
    second = next(event for event in events if event.pass_index == 2)
    assert second.fraction < 0.9


def test_the_horizon_is_trimmed_to_the_configured_days() -> None:
    run = run_dispatch(SPEC, _prices(5), DispatchConfig(start="2024-01-02", end="2024-01-03"))

    assert len(run.plan) == 2 * 48
    assert run.plan.index[0] == pd.Timestamp("2024-01-02 00:00")
    assert run.plan.index[-1] == pd.Timestamp("2024-01-03 23:30")


def test_an_uploaded_file_dispatches_like_the_prices_it_was_written_from() -> None:
    prices = _prices(2)
    buffer = io.StringIO()
    write_market_prices_csv(prices, buffer)
    buffer.seek(0)

    direct = run_dispatch(SPEC, prices, DispatchConfig())
    uploaded = run_dispatch(SPEC, load_market_prices_csv(buffer), DispatchConfig())
    pd.testing.assert_frame_equal(direct.plan, uploaded.plan, check_freq=False)


def test_a_reporter_and_a_callback_both_hear_the_run() -> None:
    from battery_plan.reporting import JsonReporter

    stream = io.StringIO()
    events: list[ProgressEvent] = []
    run_dispatch(
        SPEC,
        _prices(1),
        replace(DispatchConfig(), lookahead_days=2),
        events.append,
        reporter=JsonReporter(stream),
    )
    assert '"event": "run_finished"' in stream.getvalue()
    assert events[-1].done


def test_dates_outside_the_prices_are_an_error_not_an_empty_plan() -> None:
    with pytest.raises(ValueError, match="no prices"):
        run_dispatch(SPEC, _prices(1), DispatchConfig(start="2030-01-01", end="2030-01-02"))
