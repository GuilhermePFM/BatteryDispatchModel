"""The suite's guard against skipped tests, run on a throwaway suite of its own."""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

import pytest

_CONFTEST = Path(__file__).with_name("conftest.py")


def _run(tmp_path: Path, body: str) -> subprocess.CompletedProcess[str]:
    shutil.copy(_CONFTEST, tmp_path / "conftest.py")
    (tmp_path / "test_sample.py").write_text(f"import pytest\n\n\n{body}\n")
    return subprocess.run(
        [sys.executable, "-m", "pytest", "-p", "no:cacheprovider", str(tmp_path)],
        capture_output=True,
        text=True,
        cwd=tmp_path,
        check=False,
    )


def test_a_clean_run_passes(tmp_path: Path) -> None:
    assert _run(tmp_path, "def test_ok():\n    assert True").returncode == pytest.ExitCode.OK


@pytest.mark.parametrize(
    "body",
    [
        '@pytest.mark.skip(reason="off")\ndef test_marked():\n    pass',
        '@pytest.mark.skipif(True, reason="off")\ndef test_conditional():\n    pass',
        'def test_imperative():\n    pytest.skip("off")',
        'pytest.importorskip("a_module_that_does_not_exist")\n\ndef test_module():\n    pass',
    ],
    ids=["mark", "skipif", "imperative", "module"],
)
def test_a_skip_fails_the_run_and_is_named(tmp_path: Path, body: str) -> None:
    run = _run(tmp_path, body)

    assert run.returncode == pytest.ExitCode.TESTS_FAILED
    assert "unexpected skips" in run.stdout
    assert "test_sample" in run.stdout


def test_an_expected_failure_is_not_a_skip(tmp_path: Path) -> None:
    run = _run(tmp_path, '@pytest.mark.xfail(reason="known")\ndef test_x():\n    assert False')

    assert run.returncode == pytest.ExitCode.OK
