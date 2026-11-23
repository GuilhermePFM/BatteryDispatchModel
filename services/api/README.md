# BatteryPlan API

The Go side of the web app: the HTTP API behind CloudFront and the Lambda that
drains the dead-letter queue. It checks who is asking, validates the run
request against `contracts/`, answers repeated requests from the cache, spends
the daily quota, and puts the job on SQS for the solver. Routes, error codes,
DynamoDB items and the refund rule are fixed in
[`contracts/platform.md`](../../contracts/platform.md); this module follows it.

| Package | What it does |
| --- | --- |
| `cmd/api` | The API: a Lambda Function URL handler when `AWS_LAMBDA_RUNTIME_API` is set, a plain HTTP server on `:8080` otherwise |
| `cmd/dlq` | Fails a run whose job reached the DLQ with `solver_failed` and refunds it; an SQS-triggered Lambda in AWS, a poller of `DLQ_URL` locally (a message it cannot handle is retried up to three receives, then logged and deleted) |
| `internal/auth` | Cognito ID tokens (signature against the cached JWKS, `iss`, `aud`, `token_use = id`, `exp`); `Bearer dev:<sub>:<email>` only with `AUTH_MODE=dev` |
| `internal/runs` | The routes, submission (validate, cache by params hash, one transaction, queue), run status, and `Fail`, the refund everyone shares |
| `internal/quota` | The user's and the site's daily counters as conditional increments inside the submission's `TransactWriteItems`, and the per-IP minute counter |
| `internal/prices` | The presigned POST for an upload (key fixed to its sha256, `content-length-range` up to 5 MB) and the structural check of the CSV |
| `internal/contracts` | The four JSON Schemas, embedded; the cross-field rules; the params hash |
| `internal/store`, `config`, `lambdaurl` | Item keys and TTLs, the environment, the Function URL adapter |

## Running it

Go is pinned in the root `mise.toml`. From `services/api/`:

```bash
go test ./...       # unit tests; the DynamoDB tests start amazon/dynamodb-local in docker,
                    # and skip without docker (or with -short)
make zips           # dist/api.zip and dist/dlq.zip: bootstrap for provided.al2023, arm64
go generate ./...   # after editing contracts/v2/*.schema.json: refresh the embedded copies
```

`TestSchemasMatchContracts` fails when the embedded schemas drift from
`contracts/`, and `TestParamsHashVectors` reproduces both vectors of
`contracts/examples/v2/params-hash.json`.

Locally the API runs from the root `docker-compose.yml` (service `api`, image
target `local`; the `dlq` service runs `/dlq` from the same image). With the
stack up:

```bash
services/api/scripts/smoke.sh            # health, me, a run and its poll, an upload, 401, the 4th run's 429
```

The zips can also come out of docker, with no Go on the machine:

```bash
docker build -f services/api/Dockerfile --target zips -o services/api/dist .
```

## Configuration

| Variable | Read by | Note |
| --- | --- | --- |
| `TABLE_NAME` | api, dlq | required |
| `QUEUE_URL`, `DATA_BUCKET` | api | required |
| `AUTH_MODE` | api | `cognito` or `dev`; there is no default |
| `COGNITO_ISSUER` | api | required with `AUTH_MODE=cognito`; the JWKS is `<issuer>/.well-known/jwks.json` |
| `COGNITO_CLIENT_ID` | api | the app client id; with `AUTH_MODE=cognito` this or `COGNITO_CLIENT_ID_PARAMETER` is required |
| `COGNITO_CLIENT_ID_PARAMETER` | api | used when `COGNITO_CLIENT_ID` is empty: an SSM parameter name (Terraform sets `/batteryplan/cognito-client-id`), read once at cold start with `ssm:GetParameter`; startup fails if it cannot be read |
| `DAILY_USER_LIMIT`, `DAILY_GLOBAL_LIMIT`, `IP_RATE_PER_MINUTE` | api | 3, 60, 60 when unset; `IP_RATE_PER_MINUTE=0` turns the limit off |
| `DLQ_URL` | dlq | local poller only; in AWS the event source mapping delivers the messages |
| `AWS_REGION` | api, dlq | the SDK's region; set by Lambda in AWS (`us-east-1`), `eu-west-2` in the local stack |
| `AWS_ENDPOINT_URL` | api, dlq | LocalStack only; also switches S3 to path-style URLs |
| `AWS_LAMBDA_RUNTIME_API` | api, dlq | set by Lambda; picks the Lambda entry point |

## What the API decides that the contracts leave open

- **Upload keys.** `POST /api/uploads` fixes the key to `uploads/<sha256>.csv`,
  and `POST /api/runs` accepts only a `prices_key` of that shape, so the hash
  that goes into the params hash comes from the key and is checked against the
  object's bytes.
- **The CSV check** (`CheckPLD`) mirrors `battery_plan.data_io.check_pld_csv`
  rule for rule, in the same words, and both are held to the shared verdicts in
  `contracts/examples/pld-upload-verdicts.json`. The solver reads the file again
  and has the last word.
- **Contention.** Concurrent submissions touching the same counters cancel each
  other's transactions (`TransactionConflict`); the API retries those with
  backoff, so only a failed condition becomes a 429.
- **Failures the user did not cause** return `500` with `error.code = "internal"`.
