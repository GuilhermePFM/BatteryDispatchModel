# Validation

*What is checked, what the checks pin down, and what a reviewer should still doubt.*

[← README](../README.md) · [data](data.md) · [architecture](architecture.md) ·
[solve](solve.md) · [glossary](glossary.md)

---

## How the tests are organized

Each limit is tested through **the behaviour it exists to produce** rather than by
re-asserting its algebra. Re-stating `S(t) = S(t−1) + …` in a test proves only that
it was typed twice.

```bash
uv run pytest        # 206 tests, about two minutes
```

A skipped test fails the run: `tests/conftest.py` turns any skip into a failure,
and CI does the same for Go and for vitest, so a checkout without its data cannot
report green having checked nothing.

| File | Tests | Covers |
| --- | --: | --- |
| `test_hourly.py` | 65 | The hourly program: the LP equals the MILP with an explicit binary, no simultaneous charge and discharge, netting of zero-loss ties, one day is 24 rows, the local price shape is kept, and each contract limit of §4.5, including the rolling 366 cycles and the 12 h binary |
| `test_portfolio.py` | 14 | The 4 × 2 grid, the balanced year, the last twelve months, the ranking and regret from the merchant case, and the 24+0 backtest |
| `test_pld.py` | 57 | The canonical file against its SHA, the handling of overlapping exports, and the upload check against the verdicts shared with Go and TypeScript |
| `test_contracts.py` | 38 | The JSON Schemas of `contracts/v2`, their examples, the params-hash vectors, canonical JSON, the span rule, and a built result against the schema and its 300 KB ceiling |
| `test_solver_handler.py` | 21 | The solver Lambda against moto: a run to the end, refunds, redelivery, stale and v1 messages refused, deadlines, and failures left to the DLQ |
| `test_cli.py` | 4 | Both commands end to end, with the written plans |
| `test_finance_golden.py` | 1 | The golden vectors reproduce from the independent reference |
| `test_skip_guard.py` | 6 | The guard above, on a throwaway suite of its own |

The other two languages hold their own halves: `go test ./...` in `services/api`
and `pnpm test` in `web/`, where `src/finance/` runs the golden vectors written by
`scripts/finance_golden_vectors.py`. A strict `mypy` pass and `ruff` run alongside.

## Still open

- **The merchant value is a ceiling.** The capture factor removes the view of
  tomorrow but keeps a perfect view of today, with no forecast error
  ([the backtest](solve.md#capture-factor-240-backtest)).
- **The contracted dispatch is a proxy.** The ONS decides the real dispatch, so the
  contracted case measures cycles and losses, and its value is not revenue.
- **The rolling 366-cycle window is a reading.** The contract does not say whether
  the 12 months are rolling. The rolling window is the conservative choice.
- **The price history is short.** 670 days hold one hydrological path, and the
  choice of period moves the annual value by 12–27%, which is why the balanced year
  and the last twelve months are shown side by side.
