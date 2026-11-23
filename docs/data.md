# The inputs

*The CCEE hourly PLD, how the canonical file is built from its exports, and what
an uploaded file must satisfy.*

[← README](../README.md) · [architecture](architecture.md) · [solve](solve.md) ·
[validation](validation.md) · [glossary](glossary.md)

---

## The source

`data/raw/ccee/` holds the hourly PLD as exported from the CCEE panel. The panel
exports at most six months at a time, as a wide CSV (`;`, decimal comma) with
`Hora`, `Submercado` and one column per day. Market facts and sources are in
[`mercado-brasileiro.md`](mercado-brasileiro.md).

## The canonical file

`data/raw/pld_hourly.csv` (`hora,submercado,pld`) is built from the exports:

```bash
uv run python scripts/build_pld_csv.py
```

| | |
| --- | --- |
| Span | 2025-01-20 to 2026-11-20, 670 days |
| Rows | 16,080 hours × 4 submarkets, unique on (`hora`, `submercado`), no gaps |
| Unit | BRL/MWh |
| Integrity | `battery_plan.data_io.load_pld` checks its pinned SHA-256 |

Three decisions shape it:

- **Overlaps are checked, not assumed.** The raw files overlap on 20/06/2025,
  20/12/2025 and 20/06/2026 (288 rows, identical values). The builder keeps one
  occurrence and **fails** if a future overlap disagrees.
- **Timestamps stay in local time.** Converting `-03:00` to UTC would shift the
  daily price profile by three hours.
- **Prices must be positive.** The no-binary argument of §5.1 of the
  [formulation](model/model.md) depends on it, so a price at or below zero is
  rejected rather than cleaned.

## Uploaded files

A user can run the model on their own prices, in the canonical format. The same
check exists in Python (`check_pld_csv`), Go (`CheckPLD`) and TypeScript
(`checkPldCsv`), and all three must return the verdicts in
[`contracts/examples/pld-upload-verdicts.json`](../contracts/examples/pld-upload-verdicts.json).
It rejects offsets, duplicate keys, gaps, incomplete hours, partial days and
prices at or below zero, with a message naming the line to fix.
[`contracts/examples/pld-template.csv`](../contracts/examples/pld-template.csv)
is a valid file to start from.
