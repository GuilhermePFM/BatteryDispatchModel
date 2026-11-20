# Running the model from the command line

*The `battery-plan` command, every flag, the search comparisons, reproducing every
figure in the documents, and the Docker image that needs nothing but Docker.*

[← README](../README.md) · [architecture](architecture.md) · [solve](solve.md) ·
[cycle budget](cycle-budget.md) · [validation](validation.md)

---

The project uses [uv](https://docs.astral.sh/uv/). Python 3.12 is pinned in
`.python-version` and installed by uv if missing.

```bash
uv sync --all-groups            # create .venv, install runtime + dev deps

uv run battery-plan inputs      # load both spreadsheets, print spec + data quality
uv run battery-plan dispatch    # solve all three years (a few minutes)
```

`dispatch` writes the half-hourly plan to `data/results/` and prints the headline figures. Restrict it for a quick look:

```bash
uv run battery-plan dispatch --start 2018-01-01 --end 2018-01-31
```

| Flag | Default | What it changes |
| --- | --- | --- |
| `--start` / `--end` | all data | Horizon, trimmed on whole hours |
| `--commit-days` | `1` | How much of each solved window is kept |
| `--lookahead-days` | `1` | Foresight beyond the committed part, then discarded |
| `--search` | `cutting-plane` | Method that values the cycle budget (§6); `bisection` selects the reference method |
| `--out` | `data/results/dispatch_plan.csv` | `.csv` or `.parquet` |
| `--progress` | `auto` | How the run reports itself on stderr: `console` for the live display, `plain` for one log line per event, `json` for JSON lines, `none` for silence. `auto` reads the terminal |
| `--quiet` | off | Results only; shorthand for `--progress none` |

Web runs fix the window at `--commit-days 1 --lookahead-days 1`: the site's form
doesn't offer the two, since [`solve.md`](solve.md) shows more foresight adds
nothing on this data. The CLI keeps both flags for that comparison.

A run reports itself in phases — inputs, horizon, calibrate, recover — and keeps
one table row per pass of the cycle-value search, so a converging run looks
different from a stuck one while it is still going. Results go to stdout and
progress to stderr, so `uv run battery-plan dispatch > summary.txt` still
captures the answer, and a redirected run drops the live display for timestamped
lines on its own. `--progress json` emits the same events as JSON lines, which
is enough to plot a run's convergence without solving it again.

The cycle budget only needs a cycle value when it binds, and on the full 5,000-cycle budget it does not, so the search costs one pass and returns zero. It matters under the pro-rated budget of §5. Compare the two methods on one instance with:

```bash
uv run python scripts/compare_searches.py 30    # one instance, against an exact solve
uv run python scripts/sweep_searches.py         # 1 to 90 days, both methods side by side
```

## Reproducing the documents

Every figure the documents quote comes from one of these runs, and one command
runs all of them:

```bash
make results-list         # the stages, what each one feeds, what each one costs
make results              # re-run every measurement in the docs (~2 h)
make results-quick        # the same path over short horizons (~10 min), CSVs kept aside
```

`make results` walks the stages in reading order — the headline dispatch, the
figures read off its plan, both search methods over every horizon, the
tolerance table, and the one-shot MILPs behind `tractability.md` — rewriting
`docs/model/*.csv` and teeing every stage to `data/results/reproduce/`. One
stage at a time works too:

```bash
uv run python scripts/reproduce_docs.py dispatch results   # just the headline figures
uv run python scripts/reproduce_docs.py --dry-run          # print the commands, run nothing
```

Figures come from `data/results/dispatch_plan.csv`. Profit reproduces to the
penny across independent full-horizon runs; the period counts can move by one or
two of 52,608, where a tie between an idle period and a near-zero trade is
broken differently.

## In Docker

For better compatibility, a Docker script is available to run the model on a machine with no Python, no uv and no
solver: the image pins Python 3.12, resolves every dependency from `uv.lock`,
and carries the two input spreadsheets, so the only requirement on the host is
Docker itself.

```bash
scripts/docker-run.sh                       # full dispatch, all three years
scripts/docker-run.sh inputs                # spec + data quality
scripts/docker-run.sh dispatch --start 2018-01-01 --end 2018-01-31
make docker ARGS="dispatch --quiet"         # the same, through the Makefile
```

The script builds before it runs — a cache no-op when nothing changed, so a
code edit can never be run as a stale image — which makes one command enough
from a fresh clone. Every flag in the table above works unchanged — the
arguments go straight to `battery-plan` — and results land in
`./data/results` on the host, mounted into the container, written as the
invoking user rather than as root.

| Command | What it is for |
| --- | --- |
| `scripts/docker-run.sh [args]` | Run the CLI; no arguments means `dispatch` |
| `scripts/docker-run.sh --shell` | A shell in the image, for poking at a run |
| `make docker-test` | The test suite inside the image: the check that it runs anywhere |
| `DEV=1 ...` | Build the `:dev` image, which adds pytest, mypy, ruff and jupyterlab |
| `IMAGE=`, `RESULTS_DIR=`, `PLATFORM=` | Override the tag, the host results directory, or the build platform |

The default image installs the runtime stack only (`uv sync --no-dev`); `DEV=1`
builds with `--all-groups`. On a machine where a dependency has no wheel for the
native architecture, `PLATFORM=linux/amd64 scripts/docker-run.sh` builds and
runs under emulation instead.

This image is the command line's. The web solver has its own, built on the
Lambda base image: see [`services/solver/README.md`](../services/solver/README.md).

## Development

```bash
uv run pytest             # the Python suite, ~60 s
uv run mypy               # strict
uv run ruff check . --fix
uv run ruff format .
make preview              # render docs/model/model.md to HTML and open it
```
