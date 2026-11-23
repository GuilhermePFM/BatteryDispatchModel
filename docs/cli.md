# Running the model from the command line

*The `battery-plan` command, its flags, and the Docker image that needs nothing
but Docker.*

[← README](../README.md) · [architecture](architecture.md) · [solve](solve.md) ·
[validation](validation.md)

---

The project uses [uv](https://docs.astral.sh/uv/). Python 3.12 is pinned in
`.python-version` and installed by uv if missing.

```bash
uv sync --all-groups            # create .venv, install runtime + dev deps

uv run battery-plan inputs      # coverage and price level of the bundled PLD
uv run battery-plan dispatch    # 30 MW, 4 h, every submarket and case
```

`dispatch` prints the merchant ranking and writes every plan to one CSV. A run
needs at least a year, since the balanced year of §8.3 needs all twelve months:

```bash
uv run battery-plan dispatch --start 2025-02-01 --end 2026-01-31 --power-mw 1
```

| Flag | Default | What it changes |
| --- | --- | --- |
| `--start` / `--end` | all data | Horizon in whole days, `--end` included |
| `--power-mw` | `30` | Power delivered to the grid |
| `--hours` | `4` | Duration delivered at that power |
| `--out` | `data/results/dispatch_plan.csv` | Where the plans go |
| `--quiet` | off | Results only, no progress on stderr |

The other battery parameters take the §2 defaults of
[`HourlyBattery.sized`](../src/battery_plan/modelling/hourly.py). Results go to
stdout and progress to stderr, so `uv run battery-plan dispatch > summary.txt`
still captures the answer. The financial layer is not in the CLI: it runs in the
browser (`web/src/finance/`).

## Regenerating the derived files

```bash
uv run python scripts/build_pld_csv.py          # data/raw/pld_hourly.csv from the CCEE exports
uv run python scripts/contract_examples_v2.py   # contracts/examples/v2/
uv run python scripts/build_scenario_v2.py      # the site's precomputed dashboard
uv run python scripts/finance_golden_vectors.py # the golden vectors of the finance tests
uv run python scripts/measure_pld_dispatch.py   # the measurements in solve.md
```

## In Docker

The image pins Python 3.12, resolves every dependency from `uv.lock` and carries
the bundled PLD, so the only requirement on the host is Docker.

```bash
scripts/docker-run.sh                       # the full portfolio
scripts/docker-run.sh inputs                # coverage and level of the PLD
scripts/docker-run.sh dispatch --start 2025-02-01 --end 2026-01-31
make docker ARGS="dispatch --quiet"         # the same, through the Makefile
```

The script builds before it runs, a cache no-op when nothing changed, so a code
edit can never run as a stale image. Arguments go straight to `battery-plan`, and
results land in `./data/results` on the host, written as the invoking user.

| Command | What it is for |
| --- | --- |
| `scripts/docker-run.sh [args]` | Run the CLI; no arguments means `dispatch` |
| `scripts/docker-run.sh --shell` | A shell in the image, for poking at a run |
| `make docker-test` | The test suite inside the image |
| `DEV=1 ...` | Build the `:dev` image, which adds pytest, mypy and ruff |
| `IMAGE=`, `RESULTS_DIR=`, `PLATFORM=` | Override the tag, the host results directory, or the build platform |

This image is the command line's. The web solver has its own, built on the Lambda
base image: see [`services/solver/README.md`](../services/solver/README.md).

## Development

```bash
uv run pytest             # the Python suite
uv run mypy               # strict
uv run ruff check . --fix
uv run ruff format .
make preview              # render docs/model/model.md to HTML and open it
make pdf                  # typeset it and refresh docs/model/battery-dispatch.pdf
```
