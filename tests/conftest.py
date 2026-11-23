"""Suite-wide rule: a skipped test is a failed run.

The tests that read the supplied data used to skip when it was absent, so a
checkout without the data reported green having checked nothing. They now fail
instead, and this guard keeps a new skip from reopening the gap.
"""

from __future__ import annotations

import pytest

_skipped: list[str] = []


def pytest_runtest_logreport(report: pytest.TestReport) -> None:
    """Record a skipped test; an expected failure is reported apart and does not count."""
    if report.skipped and not hasattr(report, "wasxfail"):
        _skipped.append(report.nodeid)


def pytest_collectreport(report: pytest.CollectReport) -> None:
    """Record a module skipped whole, as ``importorskip`` does at import."""
    if report.skipped:
        _skipped.append(report.nodeid)


def pytest_sessionfinish(session: pytest.Session) -> None:
    """Fail a run that would otherwise pass with tests skipped."""
    # A module skipped whole leaves nothing collected, which is its own exit code.
    passing = (pytest.ExitCode.OK, pytest.ExitCode.NO_TESTS_COLLECTED)
    if _skipped and session.exitstatus in passing:
        session.exitstatus = pytest.ExitCode.TESTS_FAILED


def pytest_terminal_summary(terminalreporter: pytest.TerminalReporter) -> None:
    """Name what was skipped, since that is what has to be fixed."""
    if _skipped:
        terminalreporter.section("unexpected skips")
        for nodeid in _skipped:
            terminalreporter.line(nodeid)
