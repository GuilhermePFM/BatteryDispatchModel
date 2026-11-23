"""The hourly PLD: the CCEE exports, the canonical file built from them, and its upload check.

The CCEE panel exports at most six months at a time, as a wide table with one
column per day, so the files in ``data/raw/ccee`` can overlap on the days where
one export ends and the next begins. :func:`build_canonical_pld` keeps one copy
of each overlapping hour and fails if two exports disagree on it. It reads only
the exports from :data:`PLD_CANONICAL_START` on: the older ones have missing days
and daylight-saving hours, which the hourly model does not accept.

Hours are local market time and carry no offset: converting ``-03:00`` to UTC
would move the daily price shape by three hours.

:func:`check_pld_csv` is mirrored by ``services/api/internal/prices/pld.go`` and
``web/src/lib/pld.ts``. All three return the same verdict on the shared cases in
``contracts/examples/pld-upload-verdicts.json``.
"""

from __future__ import annotations

import csv
import hashlib
import io
import itertools
import math
import re
from datetime import datetime, timedelta
from decimal import Decimal, InvalidOperation
from pathlib import Path

import pandas as pd

from battery_plan.data_io.paths import CCEE_RAW_DIR, PLD_HOURLY_CSV

#: Submarkets in canonical order, as the CCEE names them and as this project does.
CCEE_SUBMARKETS: dict[str, str] = {"SUDESTE": "SE", "SUL": "S", "NORDESTE": "NE", "NORTE": "N"}
SUBMARKETS = tuple(CCEE_SUBMARKETS.values())

PLD_CSV_HEADER = "hora,submercado,pld"

#: sha256 of ``data/raw/pld_hourly.csv``; rebuild with ``scripts/build_pld_csv.py``.
PLD_HOURLY_SHA256 = "2431c61473ae39b0ed949364306974e6ee8b5b88d8d051d6bedb19a688c9b839"

#: The first day of the canonical file; exports that start earlier are kept but not merged.
PLD_CANONICAL_START = datetime(2025, 1, 20)

#: What each rejection tells the user. Shared word for word with Go and TypeScript.
PLD_ERRORS: dict[str, str] = {
    "encoding": "The file is not UTF-8 text.",
    "empty": "The file is empty.",
    "header": f"The header row must be: {PLD_CSV_HEADER}",
    "no_rows": "The file has a header row but no prices.",
    "fields": "Every row must be: hora,submercado,pld",
    "timestamp": "hora must be a local time as YYYY-MM-DDTHH:00.",
    "offset": "hora must be local market time, with no UTC offset.",
    "off_hour": "hora must fall on the hour.",
    "submarket": "submercado must be SE, S, NE or N.",
    "price": "pld must be a plain decimal number in BRL/MWh.",
    "non_positive": "pld must be greater than zero.",
    "duplicate": "This hour and submercado already appear earlier in the file.",
    "order": "Rows must be in time order.",
    "gap": "Hours must be consecutive, with no gaps.",
    "incomplete": "Each hour must have all four submercados.",
    "partial_day": "The file must hold whole days, from 00:00 to 23:00.",
}

_TIMESTAMP = re.compile(r"([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2})")
_WITH_OFFSET = re.compile(
    r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]+)?)?"
    r"(Z|[+-][0-9]{2}(:?[0-9]{2})?)"
)
_PRICE = re.compile(r"-?[0-9]+(\.[0-9]+)?")
_EPOCH = datetime(1970, 1, 1)
_HOUR = timedelta(hours=1)


class PldFileError(ValueError):
    """An uploaded PLD file that cannot be used, with a stable code and the line to fix."""

    def __init__(self, code: str, line: int) -> None:
        super().__init__(f"line {line}: {PLD_ERRORS[code]}")
        self.code = code
        self.line = line


class PldDataError(ValueError):
    """The CCEE exports cannot be merged into one trustworthy series."""


def check_pld_csv(data: bytes) -> None:
    """Accept a canonical PLD file or raise :class:`PldFileError` for its first defect.

    Rows are read in order and the first bad row decides the verdict; the checks
    across rows (duplicates, order, gaps, whole days) run after that.
    """
    try:
        text = data.decode("utf-8").removeprefix("﻿")
    except UnicodeDecodeError as error:
        raise PldFileError("encoding", 1) from error

    lines = [line.removesuffix("\r") for line in text.split("\n")]
    while lines and lines[-1] == "":
        lines.pop()
    if not lines:
        raise PldFileError("empty", 1)
    if lines[0] != PLD_CSV_HEADER:
        raise PldFileError("header", 1)
    if len(lines) == 1:
        raise PldFileError("no_rows", 1)

    rows = [_parse_row(text, number) for number, text in enumerate(lines[1:], start=2)]
    _check_series(rows)


def _parse_row(text: str, line: int) -> tuple[int, str, int]:
    """One row as (hours since the epoch, submarket, line), or the error it earns."""
    fields = text.split(",")
    if len(fields) != 3:
        raise PldFileError("fields", line)
    hora, submarket, price = fields

    if _WITH_OFFSET.fullmatch(hora):
        raise PldFileError("offset", line)
    match = _TIMESTAMP.fullmatch(hora)
    if match is None:
        raise PldFileError("timestamp", line)
    year, month, day, hour, minute = (int(group) for group in match.groups())
    if not 1900 <= year <= 2199:
        raise PldFileError("timestamp", line)
    try:
        moment = datetime(year, month, day, hour, minute)
    except ValueError as error:
        raise PldFileError("timestamp", line) from error
    if minute != 0:
        raise PldFileError("off_hour", line)

    if submarket not in SUBMARKETS:
        raise PldFileError("submarket", line)

    if _PRICE.fullmatch(price) is None:
        raise PldFileError("price", line)
    value = float(price)
    if not math.isfinite(value):
        raise PldFileError("price", line)
    if value <= 0:
        raise PldFileError("non_positive", line)

    return (moment - _EPOCH) // _HOUR, submarket, line


def _check_series(rows: list[tuple[int, str, int]]) -> None:
    """The checks across rows: unique keys, time order, full consecutive hours, whole days."""
    seen: set[tuple[int, str]] = set()
    for hour, submarket, line in rows:
        if (hour, submarket) in seen:
            raise PldFileError("duplicate", line)
        seen.add((hour, submarket))

    for previous, current in itertools.pairwise(rows):
        if current[0] < previous[0]:
            raise PldFileError("order", current[2])

    start = 0
    while start < len(rows):
        hour, _, line = rows[start]
        if start > 0 and hour != rows[start - 1][0] + 1:
            raise PldFileError("gap", line)
        end = start
        while end < len(rows) and rows[end][0] == hour:
            end += 1
        if end - start != len(SUBMARKETS):
            raise PldFileError("incomplete", line)
        start = end

    if rows[0][0] % 24 != 0:
        raise PldFileError("partial_day", rows[0][2])
    if rows[-1][0] % 24 != 23:
        raise PldFileError("partial_day", rows[-1][2])


def read_ccee_export(path: Path) -> dict[tuple[datetime, str], Decimal]:
    """One wide CCEE export as {(local hour, submarket): price}."""
    with path.open(encoding="ascii", newline="") as handle:
        table = list(csv.reader(handle, delimiter=";"))
    if len(table) < 2 or table[0][:2] != ["Hora", "Submercado"]:
        raise PldDataError(f"{path.name}: not a CCEE hourly price export")

    days = [datetime.strptime(label, "%d/%m/%Y") for label in table[0][2:]]
    if len(set(days)) != len(days):
        raise PldDataError(f"{path.name}: a day appears in two columns")

    prices: dict[tuple[datetime, str], Decimal] = {}
    for row in table[1:]:
        if len(row) != len(table[0]):
            raise PldDataError(f"{path.name}: row {row[:2]} has {len(row)} fields")
        submarket = CCEE_SUBMARKETS.get(row[1])
        if submarket is None:
            raise PldDataError(f"{path.name}: unknown submarket {row[1]!r}")
        for day, cell in zip(days, row[2:], strict=True):
            key = (day + timedelta(hours=int(row[0])), submarket)
            if key in prices:
                raise PldDataError(f"{path.name}: {key} appears twice")
            try:
                prices[key] = Decimal(cell.replace(",", "."))
            except InvalidOperation as error:
                raise PldDataError(f"{path.name}: {key} has price {cell!r}") from error
    return prices


def _export_start(path: Path) -> datetime:
    """The first day of a CCEE export, read from its header."""
    with path.open(encoding="ascii", newline="") as handle:
        header = next(csv.reader(handle, delimiter=";"), [])
    if len(header) < 3 or header[:2] != ["Hora", "Submercado"]:
        raise PldDataError(f"{path.name}: not a CCEE hourly price export")
    return datetime.strptime(header[2], "%d/%m/%Y")


def build_canonical_pld(raw_dir: Path = CCEE_RAW_DIR) -> str:
    """Merge the CCEE exports from :data:`PLD_CANONICAL_START` on into the canonical CSV text.

    An hour present in two exports is kept once when both agree, and is an error
    when they do not: a revised price has to be a decision, not a file order.
    """
    paths = [p for p in sorted(raw_dir.glob("*.csv")) if _export_start(p) >= PLD_CANONICAL_START]
    if not paths:
        raise PldDataError(f"no CCEE exports in {raw_dir}")

    merged: dict[tuple[datetime, str], Decimal] = {}
    for path in paths:
        for key, value in read_ccee_export(path).items():
            if merged.setdefault(key, value) != value:
                raise PldDataError(
                    f"{path.name}: {key[0]:%Y-%m-%d %H:%M} {key[1]} is {value}, "
                    f"but an earlier export has {merged[key]}"
                )

    order = {submarket: position for position, submarket in enumerate(SUBMARKETS)}
    lines = [PLD_CSV_HEADER]
    for moment, submarket in sorted(merged, key=lambda key: (key[0], order[key[1]])):
        value = merged[(moment, submarket)]
        lines.append(f"{moment:%Y-%m-%dT%H:%M},{submarket},{value.normalize():f}")
    text = "\n".join(lines) + "\n"

    try:
        check_pld_csv(text.encode())
    except PldFileError as error:
        raise PldDataError(f"the merged series is invalid: {error}") from error
    return text


def load_pld(path: Path = PLD_HOURLY_CSV) -> pd.DataFrame:
    """The hourly PLD in BRL/MWh, one column per submarket, indexed by naive local hour.

    The bundled file must match its pinned hash, so a changed input cannot move
    results unnoticed.
    """
    data = path.read_bytes()
    if path == PLD_HOURLY_CSV and hashlib.sha256(data).hexdigest() != PLD_HOURLY_SHA256:
        raise PldDataError(f"{path.name} does not match its pinned sha256")
    return parse_pld(data)


def parse_pld(data: bytes) -> pd.DataFrame:
    """A checked PLD file as :func:`load_pld` returns it, or :class:`PldFileError`."""
    check_pld_csv(data)

    frame = pd.read_csv(io.BytesIO(data), encoding="utf-8-sig", parse_dates=["hora"])
    wide = frame.pivot(index="hora", columns="submercado", values="pld")
    return wide.loc[:, list(SUBMARKETS)].rename_axis(columns=None)
