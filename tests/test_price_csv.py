"""The uploaded price file: what loads, and what each bad file is told."""

from __future__ import annotations

import io

import pandas as pd
import pytest

from battery_plan.data_io import PriceFileError, load_market_prices_csv, write_market_prices_csv
from battery_plan.data_io.paths import PROJECT_ROOT

GOOD = """timestamp,market_1,market_2
2018-01-01T00:00:00,48.47,51.89
2018-01-01T00:30:00,49.81,51.89
2018-01-01T01:00:00,53.65,55.49
2018-01-01T01:30:00,47.20,55.49
"""


def _load(text: str):  # type: ignore[no-untyped-def]
    return load_market_prices_csv(io.StringIO(text))


def test_a_good_file_loads_each_market_at_its_own_resolution() -> None:
    prices = _load(GOOD)

    assert list(prices.market_1) == [48.47, 49.81, 53.65, 47.20]
    assert list(prices.market_2) == [51.89, 55.49]
    assert prices.market_1.index[1] == pd.Timestamp("2018-01-01 00:30")
    assert list(prices.market_2.index) == [
        pd.Timestamp("2018-01-01 00:00"),
        pd.Timestamp("2018-01-01 01:00"),
    ]


def test_an_offset_is_converted_to_utc() -> None:
    shifted = GOOD.replace(":00:00,", ":00:00+01:00,").replace(":30:00,", ":30:00+01:00,")
    assert _load(shifted).market_1.index[0] == pd.Timestamp("2017-12-31 23:00")


def test_header_case_spaces_and_a_byte_order_mark_are_forgiven() -> None:
    text = "﻿ Timestamp , Market_1 ,MARKET_2\n" + GOOD.split("\n", 1)[1]
    assert len(load_market_prices_csv(io.BytesIO(text.encode("utf-8"))).market_1) == 4


def test_the_template_loads_and_writing_it_back_is_lossless() -> None:
    template = PROJECT_ROOT / "contracts" / "examples" / "prices-template.csv"
    prices = load_market_prices_csv(template)
    assert len(prices.market_1) == 31 * 48

    buffer = io.StringIO()
    write_market_prices_csv(prices, buffer)
    assert buffer.getvalue() == template.read_text()


@pytest.mark.parametrize(
    ("text", "message"),
    [
        ("", "empty"),
        ("timestamp,market_1,market_2\n", "no prices"),
        ("timestamp,market_1\n2018-01-01T00:00:00,1\n", "Missing column.*market_2"),
        (GOOD.replace(",49.81,", ",abc,"), r"market_1 must be a number.*line 3 \('abc'\)"),
        (GOOD.replace(",49.81,", ",,"), r"market_1 must be a number.*line 3"),
        (GOOD.replace(",55.49\n2018", ",n/a\n2018"), r"market_2 must be a number.*line 4"),
        (GOOD.replace("2018-01-01T00:30:00", "01/01/2018 00:30"), r"ISO 8601.*line 3"),
        (GOOD.replace("T01:00:00", "T00:30:00"), r"duplicate.*line 3.*line 4"),
        (
            GOOD.replace("2018-01-01T01:00:00,53.65,55.49\n", "").replace(
                "47.20,55.49", "47.20,51.89"
            ),
            r"gaps.*00:30:00 to 2018-01-01T01:30:00 \(line 3 to line 4\)",
        ),
        (
            "timestamp,market_1,market_2\n2018-01-01T00:30:00,1,2\n2018-01-01T00:00:00,1,2\n",
            r"time order.*line 3",
        ),
        (GOOD.replace("T00:30:00", "T00:15:00"), r"hour or the half hour.*line 3"),
        (GOOD + "2018-01-01T02:00:00,1,2\n", "whole hours"),
        (GOOD.replace("47.20,55.49", "47.20,56.00"), r"market_2.*same.*2018-01-01 01:00"),
        (GOOD.replace("48.47,51.89", "48.47,51.89,1"), r"line 2 has 4 fields.*header row has 3"),
        (GOOD.replace("48.47,51.89", "48.47,51.89,1,2"), r"line 2 has 5 fields"),
        (GOOD.replace("53.65,55.49", "53.65,55.49,1"), r"not readable as CSV.*line 4, saw 4"),
    ],
    ids=[
        "empty",
        "header-only",
        "missing-column",
        "not-a-number",
        "blank-price",
        "bad-market-2",
        "bad-timestamp",
        "duplicate",
        "gap",
        "out-of-order",
        "off-the-half-hour",
        "part-hour",
        "market-2-mismatch",
        "extra-field-first-row",
        "two-extra-fields-first-row",
        "extra-field-later-row",
    ],
)
def test_a_bad_file_is_rejected_with_a_message_that_names_the_fix(text: str, message: str) -> None:
    with pytest.raises(PriceFileError, match=message):
        _load(text)


def test_an_error_lists_a_few_rows_and_counts_the_rest() -> None:
    rows = "".join(f"2018-01-01T{h:02d}:{m:02d}:00,x,1\n" for h in range(4) for m in (0, 30))
    with pytest.raises(PriceFileError, match=r"line 6 .* and 3 more\.$"):
        _load("timestamp,market_1,market_2\n" + rows)
