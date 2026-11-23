"""Smoke tests for the command line entry point."""

from __future__ import annotations

from pathlib import Path

import pandas as pd
import pytest

from battery_plan.cli import main
from battery_plan.result_v2 import PLAN_COLUMNS

#: The shortest span a balanced year accepts: every calendar month is in it.
YEAR = ["--start", "2025-02-01", "--end", "2026-01-31"]


def test_inputs_command_runs(capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["inputs"]) == 0

    out = capsys.readouterr().out
    assert "Hourly PLD: 2025-01-20 to 2026-11-20" in out
    assert "16,080 hours in each of 4 submarkets" in out


def test_dispatch_solves_the_portfolio_and_writes_the_plans(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    out = tmp_path / "plan.csv"
    assert main(["dispatch", *YEAR, "--power-mw", "1", "--out", str(out)]) == 0

    captured = capsys.readouterr()
    assert "Merchant ranking" in captured.out
    assert "Contracted case" in captured.out
    assert "[8/8]" in captured.err

    plan = pd.read_csv(out)
    assert tuple(plan.columns) == tuple(PLAN_COLUMNS)
    assert len(plan) == 365 * 24 * 8
    assert plan["hora"].iloc[0] == "2025-02-01T00:00"
    assert plan["hora"].iloc[-1] == "2026-01-31T23:00"


def test_quiet_keeps_the_result_on_stdout_and_says_nothing_on_stderr(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """``> summary.txt`` must still capture the answer."""
    out = tmp_path / "plan.csv"
    assert main(["dispatch", *YEAR, "--power-mw", "1", "--out", str(out), "--quiet"]) == 0

    captured = capsys.readouterr()
    assert "Merchant ranking" in captured.out
    assert captured.err == ""


def test_dates_outside_the_data_are_an_error_not_a_crash(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    dates = ["--start", "2024-01-01", "--end", "2024-12-31"]
    argv = ["dispatch", *dates, "--out", str(tmp_path / "p")]
    assert main(argv) == 2
    assert "No PLD" in capsys.readouterr().err
