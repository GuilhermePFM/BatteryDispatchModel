"""Canonical locations of the inputs and outputs shipped with the repository."""

from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[3]
DATA_DIR = PROJECT_ROOT / "data"
RAW_DATA_DIR = DATA_DIR / "raw"
RESULTS_DIR = DATA_DIR / "results"

#: The CCEE hourly PLD exports as downloaded, and the canonical file built from them.
CCEE_RAW_DIR = RAW_DATA_DIR / "ccee"
PLD_HOURLY_CSV = RAW_DATA_DIR / "pld_hourly.csv"
