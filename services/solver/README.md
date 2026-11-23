# Solver

The Python half of BatteryPlan's back end: a Lambda that takes one job message
off SQS, runs the dispatch of `battery_plan`, and reports into the run's
DynamoDB item. The rules it follows are in
[`contracts/platform.md`](../../contracts/platform.md) ("Finishing a run",
"Refund"), and the payloads in the schemas next to it.

| File | What |
| --- | --- |
| `handler.py` | the Lambda entry point, `handler.handler`, for an SQS event of batch size 1 |
| `local_worker.py` | the same handler polling LocalStack's queue, for `docker compose` |
| `Dockerfile` | the Lambda image (default target) and the local poller (`--target local`) |
| `scripts/enqueue_example.py` | queues a run on the local stack as the API would, and waits for it |

Tests are in [`tests/test_solver_handler.py`](../../tests/test_solver_handler.py),
against moto (`uv run pytest tests/test_solver_handler.py`).

The formulation is in [`model.md`](../../docs/model/model.md).

## A job, start to finish

1. Refuse a message of another `version` or `model_version`: the run fails with
   `request_invalid` and its quota comes back. Validate the rest against
   `contracts/v2/job-message.schema.json`.
2. Move the run `queued → running` on condition `status = queued`. If that
   fails the message is a redelivery: log, return.
3. Load the hourly PLD: the bundled CSV, pinned by sha256 and read once per
   warm container, or the uploaded file through `parse_pld`. Check the span and
   that both dates lie inside the prices.
4. Run `solve_portfolio`, up to 4 submarkets × 2 cases, writing `progress`
   before each program. It gets a deadline: the invocation's remaining time
   (`context.get_remaining_time_in_millis()`) less `FINISH_MARGIN` (45 s) for
   the steps below. Running out of time fails the run as `solver_failed` and
   refunds it.
5. Build the result, aggregates for every case and detail for one, and refuse
   anything over 300 KB. Put all the plans at `plans/<run_id>.csv`, then set
   `succeeded`, `result_json` (compact JSON), `plan_csv_key`, the final
   `progress` and `finished_at`.

A stale message, a rejected price file (`prices_invalid`), dates the prices
cannot serve (`request_invalid`) or a solve out of time (`solver_failed`) fail
the run, refund the quota and return normally. The
status change and both refunds are one transaction conditional on
`status IN (queued, running)`, so whoever fails the run first refunds it, once.
Anything else raises, and the redrive policy hands the message to the DLQ.

## Environment

| Variable | Meaning |
| --- | --- |
| `TABLE_NAME` | the DynamoDB table |
| `DATA_BUCKET` | where plans go |
| `AWS_ENDPOINT_URL` | LocalStack only |
| `QUEUE_URL` | the jobs queue; `local_worker.py` only |
| `SOLVER_TIMEOUT_SECONDS` | the timeout of the synthetic Lambda context `local_worker.py` hands the handler, default 600 (the deployed function's) |
| `PLD_CSV`, `CONTRACTS_DIR` | set by the image; default to the repo's copies |

## Locally

```sh
docker compose up -d --build localstack solver
cd services/solver/scripts
uv run python enqueue_example.py                                   # a year, bundled prices
uv run python enqueue_example.py --start 2025-01-20 --end 2026-11-20
uv run python enqueue_example.py --prices ../../../data/raw/pld_hourly.csv
uv run python enqueue_example.py --legacy-message                  # must fail and refund
docker compose down
```

`local_worker.py` deletes a message only once the handler returns. On a raise
it makes the message visible again at once, so the next receive moves it to
the DLQ instead of waiting out the queue's 900 s visibility timeout.

## The image

```sh
docker buildx build --platform linux/arm64 -f services/solver/Dockerfile \
    -t batteryplan-solver --load .
```

Built from the repo root, on `public.ecr.aws/lambda/python:3.12`, for arm64
(Graviton). The dependencies come from `uv.lock`: the package's own and the
`solver` group (`jsonschema`); boto3 is the base image's. The `aws` group
installs boto3 for running locally and for the tests. The package, the bundled
hourly PLD and the v2 schemas are copied into `/var/task` next to the handler.

To try the Lambda entry point itself, the base image's runtime emulator serves
it on port 8080:

```sh
docker run --rm -p 9000:8080 -e TABLE_NAME=... -e DATA_BUCKET=... batteryplan-solver
curl -d @event.json http://localhost:9000/2015-03-31/functions/function/invocations
```

## The precomputed scenario

```sh
uv run python scripts/build_scenario_v2.py
```

Solves a 30 MW, 4 h battery with the §2 defaults over every day of the bundled
PLD and writes the v2 result to `web/public/scenarios/pld-2025-2026.json`, the
dashboard the site opens on.
