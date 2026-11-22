"""Input/output: where the inputs live, how they are read and described.

The spreadsheets supplied with the exercise, and the CSV a user uploads.
"""

from battery_plan.data_io.loaders import (
    PRICE_CSV_COLUMNS,
    PriceFileError,
    load_battery_spec,
    load_market_prices,
    load_market_prices_csv,
    write_market_prices_csv,
)
from battery_plan.data_io.paths import (
    BATTERY_SPEC_XLSX,
    DATA_DIR,
    MARKET_PRICES_XLSX,
    PROJECT_ROOT,
    RAW_DATA_DIR,
    RESULTS_DIR,
)
from battery_plan.data_io.quality import price_quality_report

__all__ = [
    "BATTERY_SPEC_XLSX",
    "DATA_DIR",
    "MARKET_PRICES_XLSX",
    "PRICE_CSV_COLUMNS",
    "PROJECT_ROOT",
    "RAW_DATA_DIR",
    "RESULTS_DIR",
    "PriceFileError",
    "load_battery_spec",
    "load_market_prices",
    "load_market_prices_csv",
    "price_quality_report",
    "write_market_prices_csv",
]
