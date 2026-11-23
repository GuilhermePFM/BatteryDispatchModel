"""Rebuild ``data/raw/pld_hourly.csv`` from the CCEE exports in ``data/raw/ccee``.

Run after adding an export, then update ``PLD_HOURLY_SHA256`` with the hash printed.
"""

from __future__ import annotations

import hashlib

from battery_plan.data_io import PLD_HOURLY_CSV, build_canonical_pld


def main() -> None:
    data = build_canonical_pld().encode()
    PLD_HOURLY_CSV.write_bytes(data)
    print(f"{PLD_HOURLY_CSV}: {len(data)} bytes, sha256 {hashlib.sha256(data).hexdigest()}")


if __name__ == "__main__":
    main()
