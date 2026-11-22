# Platform conventions

What the Go API, the Python solver, the frontend and the Terraform share
beyond the JSON Schemas: storage layout, HTTP routes, configuration, and the
local stack. The schemas in this folder stay the source of truth for payload
shapes; this note fixes everything around them.

## Configuration

Every service reads the same environment variable names. Both AWS SDKs honour
`AWS_ENDPOINT_URL` natively, which is how the local stack points them at
LocalStack.

| Variable | Used by | Meaning |
| --- | --- | --- |
| `TABLE_NAME` | api, dlq, solver | The single DynamoDB table (`batteryplan`) |
| `QUEUE_URL` | api, local solver poller | The jobs queue |
| `DLQ_URL` | local dlq poller only | The jobs queue's DLQ; in AWS the event source mapping delivers its messages |
| `DATA_BUCKET` | api, solver | One bucket, prefixes `uploads/` and `plans/` |
| `AUTH_MODE` | api | `cognito` in AWS, `dev` locally |
| `COGNITO_ISSUER` | api | `https://cognito-idp.<region>.amazonaws.com/<pool id>` |
| `COGNITO_CLIENT_ID` | api | The SPA's app client id |
| `COGNITO_CLIENT_ID_PARAMETER` | api | When `COGNITO_CLIENT_ID` is empty: the SSM parameter holding it (`/batteryplan/cognito-client-id` in AWS, set this way to break a Terraform dependency cycle), read once at cold start; with `AUTH_MODE=cognito` one of the two must be set |
| `DAILY_USER_LIMIT` | api | 3 |
| `DAILY_GLOBAL_LIMIT` | api | 60 |
| `IP_RATE_PER_MINUTE` | api | 60 |
| `AWS_REGION` | all | `us-east-1` in AWS (the cheapest region, and CloudFront's ACM certificate must live there anyway), set by Lambda itself; `eu-west-2` in the local stack, which also sets `AWS_DEFAULT_REGION` for boto3 |
| `AWS_ENDPOINT_URL` | all | LocalStack only: `http://localhost.localstack.cloud:4566` |

## DynamoDB: one table

Table `batteryplan`, partition key `pk` (string), no sort key, TTL attribute
`expires_at` (epoch seconds). On-demand billing.

| Item | `pk` | Attributes | TTL |
| --- | --- | --- | --- |
| Run | `run#<run_id>` | the run-record fields, except `result`, which is stored as the string attribute `result_json` (compact JSON) to keep the item under 400 KB | 7 days |
| Cache pointer | `hash#<params_hash>` | `run_id` | 7 days |
| User quota | `quota#<sub>#<YYYY-MM-DD>` | `used` (number) | 2 days |
| Global cap | `global#<YYYY-MM-DD>` | `used` (number) | 2 days |
| IP rate | `rate#<ip>#<YYYY-MM-DDTHH:MM>` | `count` (number) | 2 minutes |
| User | `user#<sub>` | `email` (absent when the token has none), `first_seen`, `last_seen` | none |

Days are UTC. `run_id` is a ULID (26 chars, Crockford base32).

### Submitting a run (API)

1. Validate the body against run-request and the cross-field rules of
   README.md. For an upload, read the object (≤ 5 MB), check its structure,
   and check its sha256 matches the key.
2. Compute `params_hash`. If `hash#<params_hash>` exists and its run is
   `queued`, `running` or `succeeded`, return that run (`200`, `cached: true`)
   without touching the quota. A pointer to a `failed` run is ignored.
3. In one `TransactWriteItems`: add 1 to `quota#<sub>#<day>` on condition
   `used < DAILY_USER_LIMIT`, add 1 to `global#<day>` on condition
   `used < DAILY_GLOBAL_LIMIT`, put the run (`queued`), put the cache pointer.
   A cancellation names which condition failed, and that picks the 429 code.
4. Send the job-message to SQS. If the send fails, refund (below) and return 503.

### Finishing a run (solver)

- On receiving a job: move the run `queued → running` on condition
  `status = queued`. If the condition fails the message is a redelivery:
  log and return without work.
- Progress: write `progress` at once on the first event and on each new phase
  or pass, otherwise at most every 3 s, plus once at the end.
- Deadline: solve within the invocation's remaining time less 45 s for the
  writes that follow; a search out of time stops early with a within-budget
  plan and `certificate.stopped_early = true`.
- Success: put the plan CSV at `plans/<run_id>.csv`, then set `succeeded`,
  `result_json`, `plan_csv_key`, `finished_at`.
- An error the user caused (`PriceFileError` → `prices_invalid`, a
  `ValueError` from the dates → `request_invalid`): set `failed` with the
  error, refund, and return normally, so the message is not retried.
- Anything else: raise. With `maxReceiveCount = 1` the message goes to the
  DLQ, and the DLQ Lambda fails the run with `solver_failed` and refunds.

### Refund (API, solver, DLQ Lambda)

Whoever moves a run to `failed` does it in one `TransactWriteItems` of three
updates: the run (`status = failed`, `error`, `finished_at`, `updated_at`) on
condition `status IN (queued, running)`, and `ADD used -1` on
`quota#<sub>#<day>` and on `global#<day>`, where `<day>` is the UTC date of the
run's `created_at`. The counters therefore come back exactly when the run
fails, once, whoever gets there first. Afterwards it deletes `hash#<params_hash>`
on condition `run_id = <this run>`, so a later run of the same params keeps
its pointer.

A cancellation whose first reason is `ConditionalCheckFailed` means the run had
already finished: nothing to do. One cancelled by `TransactionConflict` (a
concurrent submission touching the same counters, or the other party failing
the same run) is retried with backoff.

- Python solver: `services/solver/handler.py`, `_fail`, with the run's
  `user_sub` and `created_at` from the `queued → running` update.
- Go (API after a failed send, DLQ Lambda): `internal/runs.Fail` reads the run
  first (strongly consistent; a transaction cannot return the item), returns
  `ok = false` without writing if it is not in flight, then runs the same
  transaction.

## S3

One bucket, `DATA_BUCKET`, private, with a lifecycle rule deleting both
prefixes after 7 days.

- `uploads/<sha256>.csv`: written by the browser through a presigned POST
  whose policy limits `content-length-range` to 5 MB and fixes the key.
- `plans/<run_id>.csv`: written by the solver.

The precomputed 2018–2020 scenario is not in this bucket: it is a static file
of the site, `web/public/scenarios/full-2018-2020.json`, holding a run-record
with status `succeeded` and the `result` object inline.

## HTTP API

Everything under `/api`, JSON in and out. Errors are
`{"error": {"code": "...", "message": "..."}}`, the message written for the
user.

| Route | Auth | Response |
| --- | --- | --- |
| `GET /api/health` | no | `{"ok": true}` |
| `GET /api/me` | yes | `{"sub", "email" (null when the token has none), "quota": {"used", "limit", "remaining", "resets_at"}, "global": {"remaining"}}`; also upserts the user item |
| `POST /api/uploads` | yes | body `{"sha256", "size"}` → `{"url", "fields", "prices_key"}`, a presigned POST |
| `POST /api/runs` | yes | body run-request → `202 {"run_id", "status", "cached": false}`, or `200 {..., "cached": true}` |
| `GET /api/runs/{run_id}` | no | the run-record (with `result` parsed back from `result_json`), plus `plan_csv_url`, a presigned GET valid 1 h, once succeeded |

Run ids are unguessable, so a run's page is public and shareable.

| Status | `error.code` | When |
| --- | --- | --- |
| 400 | `request_invalid`, `prices_invalid` | body fails the schema or a cross-field rule; the upload is malformed |
| 401 | `unauthorized` | missing, expired or invalid token |
| 404 | `not_found` | unknown run |
| 429 | `quota_exceeded` | the user's 3 runs of the day; body also carries `quota` |
| 429 | `global_cap` | the site's 60 runs of the day |
| 429 | `rate_limited` | over 60 requests per minute from one IP |
| 500 | `internal` | anything else the user did not cause (a DynamoDB or S3 error); logged |
| 503 | `unavailable` | the queue send failed |

Every 429 carries `Retry-After` (seconds to the next UTC midnight, or to the
next minute for `rate_limited`).

The frontend polls `GET /api/runs/{run_id}` every 3 s while the run is
`queued` or `running` (backing off up to 12 s after a miss): 20 requests a
minute, well inside the 60 per minute per IP.

### Auth

The browser signs in with Cognito (authorization code + PKCE,
`oidc-client-ts`) and sends the **ID token** as `X-Authorization: Bearer <jwt>`:
it carries `email`, which the access token does not. The header is not
`Authorization` because CloudFront's OAC overwrites that one with its SigV4
signature for the Lambda Function URL. The API reads `X-Authorization` and
falls back to `Authorization` when it is absent (handy with curl locally). It
checks the signature against the pool's JWKS (cached), `iss = COGNITO_ISSUER`,
`aud = COGNITO_CLIENT_ID`, `token_use = id` and `exp`.

`email` is optional: an identity provider may withhold it. The token is still
accepted, the user item then has no `email`, and `GET /api/me` answers
`"email": null`.

For the same OAC reason, every request with a body (`POST`, `PUT`) carries
`x-amz-content-sha256`: the lowercase hex SHA-256 of the exact body bytes,
which CloudFront cannot compute itself when signing for a Lambda origin. The
browser's direct presigned POST to S3 does not go through CloudFront and does
not need it.

With `AUTH_MODE=dev` the API instead accepts `Bearer dev:<sub>:<email>`
(`<email>` may be empty), and only then; the frontend's dev build has a
matching fake sign-in.

### Client IP

Behind CloudFront the Function URL sees CloudFront's address, so the API
takes the viewer's IP from the `CloudFront-Viewer-Address` header
(`<ip>:<port>`), which the origin request policy forwards. The Function URL
only accepts requests signed by CloudFront (OAC), so the header can be trusted.
Locally, without the header, the API uses the connection's remote address.

## Local stack

`docker compose up` from the repo root brings up:

| Service | What |
| --- | --- |
| `localstack` | SQS (queue + DLQ), DynamoDB, S3, created by `infra/local/init-aws.sh`, in `eu-west-2` |
| `api` | the Go API as a plain HTTP server on `:8080`, built from `services/api/Dockerfile`, target `local`, with `AUTH_MODE=dev` |
| `dlq` | the DLQ handler as a poller of the LocalStack DLQ (`DLQ_URL`), same image and `local` target, command `/dlq` |
| `solver` | the solver as a poller of the LocalStack queue (`QUEUE_URL`), calling the same handler the Lambda calls |

Every service reaches LocalStack at `http://localhost.localstack.cloud:4566`.
That public name resolves to 127.0.0.1; inside the compose network it is a
network alias of the `localstack` container, and on the host it reaches the
published port, so a presigned URL the API signs (the upload POST, the plan
GET) works from the browser as well as from the containers.

The frontend runs on the host with `pnpm dev`; Vite proxies `/api` to
`http://localhost:8080`, the way CloudFront routes `/api` in AWS.

In the `local` mode both pollers receive one message at a time and delete it
only after the handler returns, mimicking the Lambda event source. When the
solver's handler raises, its poller sets the message's visibility timeout to 0,
so the next receive hands it to the redrive policy (`maxReceiveCount = 1`) at
once instead of after the queue's 900 s visibility timeout. The DLQ poller
does not: a message it fails to handle reappears after the DLQ's visibility
timeout and is tried again, up to three receives; then it is logged and
deleted.

`services/api/scripts/smoke.sh` exercises the stack end to end.

## AWS sizing

What the Terraform should set, from the measurements behind the local stack:

- **Solver Lambda**: 1769 MB of memory, the point at which Lambda gives one
  full vCPU; timeout 600 s.
- **Jobs queue**: visibility timeout above the Lambda timeout (900 s, as
  the local stack uses), redrive to the DLQ with `maxReceiveCount = 1`.
- **Event source mapping** (queue → solver): batch size 1, maximum concurrency
  2, so at most two runs solve at once whatever the queue depth.
- **API role**: `s3:PutObject` on `uploads/*`, because the presigned POST is
  signed with the API's credentials and S3 checks them at upload time; plus
  `s3:GetObject` on both prefixes (the upload check, the plan's presigned GET).
- **CloudFront**: the `/api/*` behaviour's origin request policy must forward
  `CloudFront-Viewer-Address`, or every request rate-limits as CloudFront's
  own address (see "Client IP").

## Toolchain

`mise.toml` at the root pins node, pnpm, go and terraform (`mise install`).
Python stays with uv. The frontend uses pnpm.
