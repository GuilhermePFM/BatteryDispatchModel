"""The hourly PLD: the merge of the CCEE exports, the canonical file, the upload check."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import pandas as pd
import pytest

from battery_plan.data_io import (
    CCEE_RAW_DIR,
    PLD_ERRORS,
    PLD_HOURLY_CSV,
    PLD_HOURLY_SHA256,
    PROJECT_ROOT,
    SUBMARKETS,
    PldDataError,
    PldFileError,
    build_canonical_pld,
    check_pld_csv,
    load_pld,
)

_VERDICTS: dict[str, Any] = json.loads(
    (PROJECT_ROOT / "contracts/examples/pld-upload-verdicts.json").read_text()
)

#: The days where one CCEE export ends and the next begins.
_OVERLAP_DAYS = ("20/6/2025", "20/12/2025", "20/6/2026")


def _bytes(case: dict[str, Any]) -> bytes:
    return bytes.fromhex(case["hex"]) if "hex" in case else str(case["csv"]).encode()


@pytest.mark.parametrize("case", _VERDICTS["cases"], ids=lambda case: str(case["name"]))
def test_the_upload_check_returns_the_shared_verdict(case: dict[str, Any]) -> None:
    if case["code"] is None:
        check_pld_csv(_bytes(case))
        return
    with pytest.raises(PldFileError) as caught:
        check_pld_csv(_bytes(case))

    assert (caught.value.code, caught.value.line) == (case["code"], case["line"])
    assert str(caught.value) == f"line {case['line']}: {_VERDICTS['messages'][case['code']]}"


def test_the_messages_are_the_shared_ones() -> None:
    assert _VERDICTS["messages"] == PLD_ERRORS


def test_the_canonical_file_is_the_pinned_merge_of_the_exports() -> None:
    data = PLD_HOURLY_CSV.read_bytes()

    assert hashlib.sha256(data).hexdigest() == PLD_HOURLY_SHA256
    assert build_canonical_pld().encode() == data


def test_the_canonical_file_is_16080_hours_by_4_submarkets_with_a_unique_key() -> None:
    long = pd.read_csv(PLD_HOURLY_CSV, parse_dates=["hora"])

    assert len(long) == 16_080 * 4
    assert not long.duplicated(["hora", "submercado"]).any()
    assert set(long["submercado"]) == set(SUBMARKETS)
    assert long["pld"].gt(0).all()

    hours = pd.date_range("2025-01-20 00:00", "2026-11-20 23:00", freq="h")
    assert len(hours) == 16_080
    assert (long["hora"].drop_duplicates().to_numpy() == hours.to_numpy()).all()


def test_load_pld_keeps_local_hours_and_one_column_per_submarket() -> None:
    prices = load_pld()

    assert prices.shape == (16_080, 4)
    assert list(prices.columns) == list(SUBMARKETS)
    assert pd.DatetimeIndex(prices.index).tz is None
    # The first value of the export's first row, at the hour the export states.
    assert prices.index[0] == pd.Timestamp("2025-01-20 00:00")
    assert prices.notna().all().all()
    assert len(prices.loc["2025-06-20"]) == 24


def test_load_pld_refuses_a_bundled_file_that_lost_its_hash(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    altered = tmp_path / "pld_hourly.csv"
    altered.write_bytes(PLD_HOURLY_CSV.read_bytes().replace(b",SE,", b",SE,1", 1))
    monkeypatch.setattr("battery_plan.data_io.pld.PLD_HOURLY_CSV", altered)

    with pytest.raises(PldDataError, match="pinned sha256"):
        load_pld(altered)


def _copy_exports(target: Path) -> list[Path]:
    copies = []
    for path in sorted(CCEE_RAW_DIR.glob("*.csv")):
        copy = target / path.name
        copy.write_bytes(path.read_bytes())
        copies.append(copy)
    return copies


@pytest.mark.parametrize("day", _OVERLAP_DAYS)
def test_an_overlap_that_disagrees_fails_the_build(tmp_path: Path, day: str) -> None:
    for path in _copy_exports(tmp_path):
        lines = path.read_text().split("\n")
        header = lines[0].split(";")
        # Change one export only: the one where this day is the first column.
        if header[2] != day:
            continue
        row = lines[1].split(";")
        row[2] = "999,99"
        lines[1] = ";".join(row)
        path.write_text("\n".join(lines))

    with pytest.raises(PldDataError, match="earlier export"):
        build_canonical_pld(tmp_path)


def test_an_overlap_that_agrees_is_kept_once(tmp_path: Path) -> None:
    _copy_exports(tmp_path)

    assert build_canonical_pld(tmp_path) == PLD_HOURLY_CSV.read_text()


def test_a_directory_without_exports_is_an_error(tmp_path: Path) -> None:
    with pytest.raises(PldDataError, match="no CCEE exports"):
        build_canonical_pld(tmp_path)
