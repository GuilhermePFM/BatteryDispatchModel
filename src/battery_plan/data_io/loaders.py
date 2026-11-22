"""Loading of the two spreadsheets supplied with the exercise, and of uploaded prices.

The loaders stay deliberately thin: they read and name the inputs, and leave
every modelling choice to :mod:`battery_plan.modelling`. The known timestamp
anomalies around the clock changes are reported by
:mod:`battery_plan.data_io.quality`, not silently repaired.

An uploaded price file is held to a stricter rule than the spreadsheets. Those
are known and their artefacts documented; an upload is neither, so it is
*rejected* on any anomaly the quality report would count, with a
:class:`PriceFileError` that names the row, because the person reading it is
the one who has to fix the file.
"""

from __future__ import annotations

import math
from pathlib import Path
from typing import IO

import numpy as np
import pandas as pd

from battery_plan.data_io.paths import BATTERY_SPEC_XLSX, MARKET_PRICES_XLSX
from battery_plan.data_io.quality import price_quality_report
from battery_plan.data_models import (
    MARKET_1_RESOLUTION,
    MARKET_2_RESOLUTION,
    BatterySpec,
    MarketPrices,
)

#: Row labels in Attachment 1 mapped onto :class:`BatterySpec` fields.
_SPEC_FIELDS: dict[str, str] = {
    "Max charging rate": "max_charge_rate_mw",
    "Max discharging rate": "max_discharge_rate_mw",
    "Max storage volume": "max_storage_volume_mwh",
    "Battery charging efficiency": "charging_loss_fraction",
    "Battery discharging efficiency": "discharging_loss_fraction",
    "Lifetime (1)": "lifetime_years",
    "Lifetime (2)": "lifetime_cycles",
    "Storage volume degradation rate": "degradation_pct_per_cycle",
    "Capex": "capex_gbp",
    "Fixed Operational Costs": "fixed_opex_gbp_per_year",
}

MARKET_1_SHEET = "Half-hourly data"
MARKET_2_SHEET = "Hourly data"


def load_battery_spec(path: Path | str = BATTERY_SPEC_XLSX) -> BatterySpec:
    """Read Attachment 1 into a :class:`BatterySpec`."""
    frame = pd.read_excel(path, sheet_name="Data", index_col=0)
    values = frame["Values"]

    missing = [label for label in _SPEC_FIELDS if label not in values.index]
    if missing:
        raise ValueError(f"Battery spec is missing expected rows: {missing}")

    return BatterySpec(**{field: float(values[label]) for label, field in _SPEC_FIELDS.items()})


def load_market_prices(path: Path | str = MARKET_PRICES_XLSX) -> MarketPrices:
    """Read Attachment 2 into a :class:`MarketPrices`.

    The hourly sheet is laid out on the half-hourly settlement with blank rows on the
    half hours; those are dropped so each series keeps its own resolution.
    """
    sheets = pd.read_excel(path, sheet_name=[MARKET_1_SHEET, MARKET_2_SHEET], index_col=0)
    return MarketPrices(
        market_1=_read_price_series(sheets[MARKET_1_SHEET], "market_1"),
        market_2=_read_price_series(sheets[MARKET_2_SHEET], "market_2"),
    )


def _read_price_series(frame: pd.DataFrame, name: str) -> pd.Series:
    """Take the single price column of a sheet and drop the blank rows.

    Timestamps are rounded to the minute: Excel stores them as floats, so some
    land on ``00:59:59.999``. Row order is preserved — it is the order in which
    the settlement periods occur.
    """
    if frame.shape[1] != 1:
        raise ValueError(f"Expected one price column for {name}, got {list(frame.columns)}")

    series = frame.iloc[:, 0].dropna().astype(float).rename(name)
    series.index = pd.to_datetime(series.index).round("min")
    series.index.name = "timestamp"
    return series


#: Columns of an uploaded price file, in order: a half-hourly ISO 8601
#: timestamp, Market 1's half-hourly price, and Market 2's hourly price
#: repeated on both half hours of its hour.
PRICE_CSV_COLUMNS = ("timestamp", "market_1", "market_2")

#: How many offending rows an error quotes before it stops listing them.
_QUOTED_ROWS = 5


class PriceFileError(ValueError):
    """An uploaded price file that cannot be used, explained for whoever supplied it."""


def load_market_prices_csv(source: Path | str | IO[str] | IO[bytes]) -> MarketPrices:
    """Read an uploaded price file (:data:`PRICE_CSV_COLUMNS`) into a :class:`MarketPrices`.

    Timestamps with an offset are converted to UTC and the offset dropped, so
    the series compare with the spreadsheets, which carry none. Any of the
    anomalies :func:`~battery_plan.data_io.quality.price_quality_report`
    counts — a duplicate, a step that is not half an hour, a row out of order,
    a missing price — is an error here rather than a line in a report, as is a
    Market 2 price that changes within its hour.
    """
    frame = _read_price_csv(source)
    missing = [column for column in PRICE_CSV_COLUMNS if column not in frame.columns]
    if missing:
        raise PriceFileError(
            f"Missing column(s): {', '.join(missing)}. "
            f"The header row must be: {','.join(PRICE_CSV_COLUMNS)}"
        )
    if frame.empty:
        raise PriceFileError("The file has a header row but no prices.")

    timestamps = _parse_timestamps(frame["timestamp"])
    market_1 = _parse_prices(frame["market_1"], "market_1")
    market_2 = _parse_prices(frame["market_2"], "market_2")

    off_grid = timestamps != timestamps.floor(MARKET_1_RESOLUTION)
    if off_grid.any():
        raise PriceFileError(
            "Timestamps must fall on the hour or the half hour; "
            + _rows(frame.index[off_grid], frame["timestamp"])
        )

    half_hourly = pd.Series(market_1, index=timestamps, name="market_1")
    half_hourly.index.name = "timestamp"
    hourly = pd.Series(market_2, index=timestamps.floor(MARKET_2_RESOLUTION), name="market_2")
    hourly = hourly[~hourly.index.duplicated()]
    prices = MarketPrices(market_1=half_hourly, market_2=hourly)

    _check_quality(prices, frame)

    if timestamps[0].minute != 0 or timestamps[-1].minute != 30:
        raise PriceFileError(
            "The file must hold whole hours: start on the hour (e.g. 00:00) and end "
            f"on the half hour (e.g. 23:30); it runs {timestamps[0]} to {timestamps[-1]}."
        )

    spread = pd.Series(market_2, index=frame.index).groupby(timestamps.floor("h")).nunique()
    uneven = spread[spread > 1].index
    if len(uneven):
        quoted = ", ".join(f"{hour:%Y-%m-%d %H:%M}" for hour in uneven[:_QUOTED_ROWS])
        more = f" and {len(uneven) - _QUOTED_ROWS} more" if len(uneven) > _QUOTED_ROWS else ""
        raise PriceFileError(
            "market_2 is an hourly price and must be the same on both half hours of "
            f"each hour; it differs in the hour(s) starting {quoted}{more}."
        )

    return prices


def write_market_prices_csv(prices: MarketPrices, target: Path | str | IO[str]) -> None:
    """Write prices in the upload format, so that :func:`load_market_prices_csv` reads them back.

    Market 2 is laid onto Market 1's half hours by the hour each one falls in,
    so ``prices`` must be on a regular half-hourly index — a span of the
    spreadsheets away from the spring clock changes, or a loaded upload.
    """
    market_1 = prices.market_1
    stamps = pd.DatetimeIndex(market_1.index)
    market_2 = prices.market_2.reindex(stamps.floor(MARKET_2_RESOLUTION))
    if market_2.isna().any():
        raise ValueError("Market 2 has no price for some of Market 1's hours")

    frame = pd.DataFrame(
        {
            "timestamp": stamps.strftime("%Y-%m-%dT%H:%M:%S"),
            "market_1": market_1.to_numpy(),
            "market_2": market_2.to_numpy(),
        }
    )
    frame.to_csv(target, index=False)


def _read_price_csv(source: Path | str | IO[str] | IO[bytes]) -> pd.DataFrame:
    """Read every cell as text, so a bad one can be reported rather than guessed at."""
    try:
        frame = pd.read_csv(
            source, dtype=str, keep_default_na=False, skipinitialspace=True, encoding="utf-8-sig"
        )
    except pd.errors.EmptyDataError as error:
        raise PriceFileError("The file is empty.") from error
    except pd.errors.ParserError as error:
        raise PriceFileError(f"The file is not readable as CSV: {error}") from error
    except UnicodeDecodeError as error:
        raise PriceFileError("The file is not UTF-8 text.") from error
    if not isinstance(frame.index, pd.RangeIndex):
        # Extra fields on the first row make pandas read the leading columns as
        # an index (extra fields on a later row raise ParserError above).
        raise PriceFileError(
            f"line 2 has {len(frame.columns) + frame.index.nlevels} fields but the header row has "
            f"{len(frame.columns)}; every row must be: timestamp,market_1,market_2"
        )
    frame.columns = [str(column).strip().lower() for column in frame.columns]
    return frame


def _parse_timestamps(column: pd.Series) -> pd.DatetimeIndex:
    """ISO 8601 timestamps, naive; an offset is converted to UTC first."""
    parsed = pd.to_datetime(column.str.strip(), format="ISO8601", errors="coerce", utc=True)
    bad = parsed.isna()
    if bad.any():
        raise PriceFileError(
            "timestamp must be an ISO 8601 date and time (e.g. 2018-01-01T00:30:00); "
            + _rows(column.index[bad], column)
        )
    return pd.DatetimeIndex(parsed).tz_localize(None).rename("timestamp")


def _parse_prices(column: pd.Series, name: str) -> np.ndarray:
    """A price column as floats, or an error naming the cells that are not prices."""
    values = np.array([_float(cell) for cell in column], dtype=float)
    bad = ~np.isfinite(values)
    if bad.any():
        raise PriceFileError(
            f"{name} must be a number (£/MWh) in every row; " + _rows(column.index[bad], column)
        )
    return values


def _float(cell: str) -> float:
    """``float`` rather than ``pd.to_numeric``, whose fast parser does not round-trip."""
    try:
        return float(cell)
    except ValueError:
        return math.nan


def _check_quality(prices: MarketPrices, frame: pd.DataFrame) -> None:
    """Turn the quality report's counts for Market 1 into an error naming the first case.

    Only Market 1 is read: the half-hourly timestamps are the file's own, while
    the hourly series was derived from them and carries the same anomalies.
    """
    report = price_quality_report(prices).loc["market_1"]
    stamps = prices.market_1.index
    column = frame["timestamp"]
    if report["duplicate_timestamps"]:
        repeated = frame.index[stamps.duplicated(keep=False)]
        raise PriceFileError(
            f"{report['duplicate_timestamps']} duplicate timestamp(s); " + _rows(repeated, column)
        )
    steps = stamps.to_series().diff()
    if not report["monotonic"]:
        back = frame.index[(steps < pd.Timedelta(0)).to_numpy()]
        raise PriceFileError("Rows must be in time order; " + _rows(back, column))
    if report["irregular_steps"]:
        irregular = (steps != MARKET_1_RESOLUTION).to_numpy(copy=True)
        irregular[0] = False  # the first row has no step before it
        gaps = frame.index[irregular]
        first = gaps[0]
        raise PriceFileError(
            "Timestamps must be consecutive half hours with no gaps; "
            f"the file jumps from {column[first - 1]} to {column[first]} "
            f"(line {first + 1} to line {first + 2})"
            + (f", and {len(gaps) - 1} more gap(s)" if len(gaps) > 1 else "")
            + "."
        )


def _rows(index: pd.Index, column: pd.Series) -> str:
    """``line 7 ('abc'), line 9 ('')`` — the lines as a spreadsheet would number them."""
    quoted = ", ".join(f"line {row + 2} ({column[row]!r})" for row in index[:_QUOTED_ROWS])
    more = f" and {len(index) - _QUOTED_ROWS} more" if len(index) > _QUOTED_ROWS else ""
    return f"see {quoted}{more}."
