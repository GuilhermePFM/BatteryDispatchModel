#!/usr/bin/env bash
# Smoke test of a running API with AUTH_MODE=dev (docker compose up, or
# `go run ./cmd/api` against LocalStack). Each run signs in as a fresh user,
# so it can be repeated; it spends that user's three runs of the day.
#
#   services/api/scripts/smoke.sh [base url]     default http://localhost:8080
#
# Needs curl and jq. POLL_SECONDS (default 180) bounds the wait for the first
# run to finish; without a solver running it stays queued, which is reported
# rather than failed.
set -euo pipefail

BASE=${1:-http://localhost:8080}
POLL_SECONDS=${POLL_SECONDS:-180}
USER_SUB="smoke-$(date +%s)-$RANDOM"
TOKEN="dev:$USER_SUB:$USER_SUB@example.com"
HERE=$(cd "$(dirname "$0")" && pwd)
TEMPLATE="$HERE/../../../data/raw/pld_hourly.csv"

pass=0
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { pass=$((pass + 1)); echo "ok   $*"; }

# call METHOD PATH [BODY] [TOKEN]: sets $status, $body and $headers.
call() {
  local method=$1 path=$2 data=${3:-} token=${4-$TOKEN}
  local args=(-sS -X "$method" -D "$tmp/headers" -o "$tmp/body" -w '%{http_code}')
  [[ -n $token ]] && args+=(-H "X-Authorization: Bearer $token")
  [[ -n $data ]] && args+=(-H 'Content-Type: application/json' --data "$data")
  status=$(curl "${args[@]}" "$BASE$path")
  body=$(cat "$tmp/body")
  headers=$(cat "$tmp/headers")
}
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

request() { # request VOLUME_KWH [EXTRA JSON FIELDS]
  jq -cn --argjson kwh "$1" --argjson extra "${2:-{\}}" '{
    battery: {power_mw: 30, volume_mwh: ($kwh / 1000), max_charge_mw: 32, max_discharge_mw: 33,
              charge_efficiency: 0.922, discharge_efficiency: 0.922, degradation_pct_per_cycle: 0.001},
    start: "2025-02-01", end: "2026-01-31"} + $extra'
}
# A volume nobody else has used, so the first run is not answered from the cache.
volume_kwh=$((135000 + RANDOM + $(date +%S)))

call GET /api/health "" ""
[[ $status == 200 && $(jq -r .ok <<<"$body") == true ]] || fail "health: $status $body"
ok "GET /api/health"

call GET /api/me
[[ $status == 200 && $(jq -r .sub <<<"$body") == "$USER_SUB" ]] || fail "me: $status $body"
[[ $(jq -r .quota.remaining <<<"$body") == 3 ]] || fail "me: fresh user without 3 runs: $body"
ok "GET /api/me as $USER_SUB: $(jq -c .quota <<<"$body")"

call GET /api/me "" "not-a-jwt"
[[ $status == 401 && $(jq -r .error.code <<<"$body") == unauthorized ]] || fail "bad token: $status $body"
ok "GET /api/me with an invalid token: 401 unauthorized"

call POST /api/runs '{"start":"2025-01-20"}'
[[ $status == 400 && $(jq -r .error.code <<<"$body") == request_invalid ]] || fail "invalid body: $status $body"
ok "POST /api/runs with an invalid body: 400 request_invalid"

call POST /api/runs "$(request $volume_kwh)"
[[ $status == 202 && $(jq -r .cached <<<"$body") == false ]] || fail "run 1: $status $body"
run_id=$(jq -r .run_id <<<"$body")
ok "POST /api/runs: 202 $run_id"

call POST /api/runs "$(request $volume_kwh)"
[[ $status == 200 && $(jq -r .cached <<<"$body") == true && $(jq -r .run_id <<<"$body") == "$run_id" ]] ||
  fail "resubmission: $status $body"
ok "POST /api/runs again: 200 cached, same run, no quota spent"

state=""
for ((i = 0; i < POLL_SECONDS; i++)); do
  call GET "/api/runs/$run_id" "" ""
  [[ $status == 200 ]] || fail "poll: $status $body"
  state=$(jq -r .status <<<"$body")
  [[ $state == succeeded || $state == failed ]] && break
  sleep 1
done
case $state in
  succeeded)
    size=$(jq -cj .result <<<"$body" | wc -c)
    ((size <= 300000)) || fail "result is $size bytes, over the 300 KB ceiling"
    [[ $(jq '.result.cases | length' <<<"$body") == 8 ]] || fail "result without its 8 cases"
    ok "GET /api/runs/$run_id: succeeded, $size bytes, best $(jq -r '.result.ranking[0] | "\(.submarket) R$\(.balanced_year_brl | floor)/year"' <<<"$body"), plan $(jq -r '.plan_csv_url | .[0:60]' <<<"$body")..."
    ;;
  failed) ok "GET /api/runs/$run_id: failed ($(jq -c .error <<<"$body"))" ;;
  *) ok "GET /api/runs/$run_id: still $state after ${POLL_SECONDS}s (is the solver running?)" ;;
esac

call GET /api/runs/01JD3X7Q8RZK5V2N4M6P9T0WYA "" ""
[[ $status == 404 && $(jq -r .error.code <<<"$body") == not_found ]] || fail "unknown run: $status $body"
ok "GET an unknown run: 404 not_found"

# An upload: presigned POST straight to S3, then a run on it.
if [[ -f $TEMPLATE ]]; then
  sum=$(sha256sum "$TEMPLATE" | cut -d' ' -f1)
  call POST /api/uploads "{\"sha256\":\"$sum\",\"size\":$(wc -c <"$TEMPLATE")}"
  [[ $status == 200 ]] || fail "uploads: $status $body"
  form=()
  while IFS= read -r field; do form+=(-F "$field"); done < <(jq -r '.fields | to_entries[] | "\(.key)=\(.value)"' <<<"$body")
  s3_status=$(curl -sS -o "$tmp/s3" -w '%{http_code}' "${form[@]}" -F "file=@$TEMPLATE" "$(jq -r .url <<<"$body")")
  [[ $s3_status == 204 || $s3_status == 200 || $s3_status == 201 ]] || fail "S3 POST: $s3_status $(cat "$tmp/s3")"
  ok "POST /api/uploads + presigned POST to S3: $s3_status"
  key=$(jq -r .prices_key <<<"$body")
  call POST /api/runs "$(request $((volume_kwh + 1)) "{\"prices_key\":\"$key\",\"start\":\"2025-03-01\",\"end\":\"2026-02-28\"}")"
  [[ $status == 202 || $status == 200 ]] || fail "run on upload: $status $body"
  ok "POST /api/runs on the upload: $status $(jq -r .run_id <<<"$body")"
else
  call POST /api/runs "$(request $((volume_kwh + 1)))"
  [[ $status == 202 ]] || fail "run 2: $status $body"
  ok "POST /api/runs: 202 (no template found, upload skipped)"
fi

call POST /api/runs "$(request $((volume_kwh + 2)))"
[[ $status == 202 ]] || fail "run 3: $status $body"
ok "POST /api/runs: 202, the third of the day"

call POST /api/runs "$(request $((volume_kwh + 3)))"
retry=$(grep -i '^retry-after:' <<<"$headers" | tr -d '\r' | cut -d' ' -f2)
[[ $status == 429 && $(jq -r .error.code <<<"$body") == quota_exceeded && -n $retry ]] || fail "run 4: $status $body"
ok "POST /api/runs a fourth time: 429 quota_exceeded, Retry-After ${retry}s, $(jq -c .quota <<<"$body")"

echo "smoke: $pass checks passed against $BASE"
