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
| `scripts/precompute_scenario.py` | writes `web/public/scenarios/full-2018-2020.json` |

Tests are in [`tests/test_solver_handler.py`](../../tests/test_solver_handler.py),
against moto (`uv run pytest tests/test_solver_handler.py`).

## A job, start to finish

1. Validate the message against `job-message.schema.json`.
2. Move the run `queued → running` on condition `status = queued`. If that
   fails the message is a redelivery: log, return.
3. Load the prices: the bundled spreadsheet (read once per warm container), or
   the uploaded CSV through `load_market_prices_csv`. Check both dates lie
   inside them.
4. Run `run_dispatch`, writing `progress` at most every 3 s.
5. Put the plan at `plans/<run_id>.csv`, then set `succeeded`, `result_json`
   (compact JSON), `plan_csv_key`, the final `progress` and `finished_at`.

A rejected price file (`prices_invalid`) or dates outside the prices
(`request_invalid`) fail the run, refund the quota and return normally. The
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
| `PRICES_XLSX`, `CONTRACTS_DIR` | set by the image; default to the repo's copies |

## Locally

```sh
docker compose up -d --build localstack solver
cd services/solver/scripts
uv run python enqueue_example.py                                   # 3 days, bundled prices
uv run python enqueue_example.py --start 2019-01-01 --end 2019-12-31
uv run python enqueue_example.py --prices ../../../contracts/examples/prices-template.csv \
    --start 2018-01-01 --end 2018-01-31
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
installs boto3 for running locally and for the tests. The package, the 2018-2020
spreadsheet and the schemas are copied into `/var/task` next to the handler.

To try the Lambda entry point itself, the base image's runtime emulator serves
it on port 8080:

```sh
docker run --rm -p 9000:8080 -e TABLE_NAME=... -e DATA_BUCKET=... batteryplan-solver
curl -d @event.json http://localhost:9000/2015-03-31/functions/function/invocations
```

## The precomputed scenario

```sh
uv run python services/solver/scripts/precompute_scenario.py
```

Runs Attachment 1 over all of 2018-2020 (cutting planes, commit 1, lookahead 1;
about 3 minutes) and writes it as a succeeded run-record, validated against
the schema. Its `plan_csv_key` is the placeholder `precomputed/no-plan-csv`:
the schema requires one, and this run's plan is in no bucket.
