// VITE_API_MOCK=1: a fetch shim serving the API of contracts/platform.md from
// the contract examples, so form -> queued -> progress -> result can be
// clicked through without the backend. State lives in sessionStorage, so a
// run's page survives a reload in the same tab.
//
// To see the other answers: an upload makes the run fail with prices_invalid;
// a fourth run in a day gets quota_exceeded; and
//   sessionStorage.setItem("mock:force", "global_cap" | "rate_limited" | "unavailable" | "request_invalid")
// makes the next POST /api/runs answer with that error.
import recordExample from "../../../contracts/examples/v2/run-record.example.json";
import resultExample from "../../../contracts/examples/v2/result.example.json";
import type { Progress, Result, RunRecord, RunRequest, Submarket } from "../contracts/types";

const STORE = "mock:runs";
const QUOTA = "mock:quota";
const LIMIT = 3;
const QUEUED_MS = 2500;
const CASE_MS = 900;
const CASES_TOTAL = 8;
const MOCK_S3 = "/__mock_s3__/upload";
const ORDER: Submarket[] = ["SE", "S", "NE", "N"];

interface MockRun {
  id: string;
  request: RunRequest;
  key: string;
  created: number;
  sub: string;
}

function load<T>(key: string, fallback: T): T {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown): void {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode: state lasts until reload */
  }
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function error(status: number, code: string, message: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return json(status, { error: { code, message }, ...extra }, headers);
}

function secondsToMidnight(): number {
  const now = new Date();
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.ceil((midnight - now.getTime()) / 1000);
}

function ulid(): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let out = "";
  for (let i = 0; i < 26; i++) out += alphabet[Math.floor(Math.random() * 32)];
  return out;
}

function stamp(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function sub(auth: string | null): string | null {
  const match = /^Bearer dev:([^:]+):(.+)$/.exec(auth ?? "");
  return match ? match[1] : null;
}

function email(auth: string | null): string | null {
  return /^Bearer dev:[^:]+:(.+)$/.exec(auth ?? "")?.[1] ?? null;
}

function quota(owner: string) {
  const today = new Date().toISOString().slice(0, 10);
  const counts = load<Record<string, number>>(QUOTA, {});
  const used = counts[`${owner}#${today}`] ?? 0;
  const midnight = new Date(Date.now() + secondsToMidnight() * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  return { used, limit: LIMIT, remaining: Math.max(0, LIMIT - used), resets_at: midnight };
}

function spend(owner: string, delta: number): void {
  const today = new Date().toISOString().slice(0, 10);
  const counts = load<Record<string, number>>(QUOTA, {});
  counts[`${owner}#${today}`] = Math.max(0, (counts[`${owner}#${today}`] ?? 0) + delta);
  save(QUOTA, counts);
}

function planCsv(result: Result): string {
  const w = result.detail.week;
  const rows = ["hora,pld,charge_mw,discharge_mw,storage_mwh"];
  w.hora.forEach((t, i) => rows.push([t, w.price[i], w.charge_mw[i], w.discharge_mw[i], w.storage_mwh[i]].join(",")));
  return `data:text/csv;charset=utf-8,${encodeURIComponent(rows.join("\n"))}`;
}

/** The record the API would return for a mock run at this moment. */
function snapshot(run: MockRun, now = Date.now()): RunRecord {
  const started = run.created + QUEUED_MS;
  const finished = started + CASES_TOTAL * CASE_MS + 500;
  const base: RunRecord = {
    version: 2,
    run_id: run.id,
    user_sub: run.sub,
    params_hash: recordExample.params_hash,
    status: "queued",
    request: run.request,
    created_at: stamp(run.created),
    updated_at: stamp(Math.min(now, finished)),
  };
  if (now < started) return base;

  const elapsed = (Math.min(now, finished) - started) / 1000;
  const failing = Boolean(run.request.prices_key);
  if (failing && now >= started + 1500) {
    return {
      ...base,
      status: "failed",
      started_at: stamp(started),
      finished_at: stamp(started + 1500),
      error: {
        code: "prices_invalid",
        message: "line 214: pld must be greater than zero.",
      },
    };
  }
  if (now >= finished) {
    return {
      ...base,
      status: "succeeded",
      started_at: stamp(started),
      finished_at: stamp(finished),
      progress: { phase: "done", cases_done: CASES_TOTAL, cases_total: CASES_TOTAL, submarket: null, case: null, fraction: 1, elapsed, done: true, updated_at: stamp(finished) },
      result: resultExample as unknown as Result,
      plan_csv_key: `plans/${run.id}.csv`,
      plan_csv_url: planCsv(resultExample as unknown as Result),
    };
  }
  const done = Math.min(CASES_TOTAL - 1, Math.floor((now - started) / CASE_MS));
  const progress: Progress = {
    phase: "solving",
    cases_done: done,
    cases_total: CASES_TOTAL,
    submarket: ORDER[Math.floor(done / 2)],
    case: done % 2 === 0 ? "merchant" : "contracted",
    fraction: done / CASES_TOTAL,
    elapsed,
    done: false,
    updated_at: stamp(now),
  };
  return { ...base, status: "running", started_at: stamp(started), progress };
}

async function handle(url: URL, init: RequestInit | undefined, request: Request | null): Promise<Response> {
  const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
  const headers = new Headers(init?.headers ?? request?.headers);
  const auth = headers.get("X-Authorization") ?? headers.get("Authorization");
  const path = url.pathname;
  await new Promise((resolve) => setTimeout(resolve, 250));

  if (path === MOCK_S3 && method === "POST") return new Response(null, { status: 204 });
  if (path === "/api/health") return json(200, { ok: true });

  if (path === "/api/me" || path === "/api/uploads" || (path === "/api/runs" && method === "POST")) {
    const owner = sub(auth);
    if (!owner) return error(401, "unauthorized", "Sign in to continue.");
    if (path === "/api/me") {
      return json(200, { sub: owner, email: email(auth), quota: quota(owner), global: { remaining: 57 } });
    }
    const raw = init?.body;
    const body = JSON.parse(raw instanceof Uint8Array ? new TextDecoder().decode(raw) : String(raw ?? "{}"));
    if (path === "/api/uploads") {
      if (!/^[0-9a-f]{64}$/.test(body.sha256 ?? "")) return error(400, "request_invalid", "sha256 must be 64 lowercase hex characters.");
      if (!(body.size > 0 && body.size <= 5 * 1024 * 1024)) return error(400, "request_invalid", "The file must be between 1 byte and 5 MB.");
      return json(200, { url: MOCK_S3, fields: { key: `uploads/${body.sha256}.csv`, policy: "mock" }, prices_key: `uploads/${body.sha256}.csv` });
    }
    const forced = sessionStorage.getItem("mock:force");
    if (forced) {
      sessionStorage.removeItem("mock:force");
      if (forced === "global_cap") return error(429, "global_cap", "The site has used all 60 runs for today.", {}, { "Retry-After": String(secondsToMidnight()) });
      if (forced === "rate_limited") return error(429, "rate_limited", "Too many requests from your address.", {}, { "Retry-After": "42" });
      if (forced === "unavailable") return error(503, "unavailable", "The run could not be queued.");
      if (forced === "request_invalid") return error(400, "request_invalid", "end - start must be at most 730 days.");
    }
    const key = JSON.stringify(body);
    const runs = load<MockRun[]>(STORE, []);
    const cached = runs.find((run) => run.key === key && snapshot(run).status !== "failed");
    if (cached) return json(200, { run_id: cached.id, status: snapshot(cached).status, cached: true });
    const q = quota(owner);
    if (q.remaining <= 0) {
      return error(429, "quota_exceeded", "You have used your 3 runs for today.", { quota: q }, { "Retry-After": String(secondsToMidnight()) });
    }
    const run: MockRun = { id: ulid(), request: body, key, created: Date.now(), sub: owner };
    runs.push(run);
    save(STORE, runs);
    spend(owner, 1);
    return json(202, { run_id: run.id, status: "queued", cached: false });
  }

  const match = /^\/api\/runs\/([^/]+)$/.exec(path);
  if (match && method === "GET") {
    const id = decodeURIComponent(match[1]);
    if (id === recordExample.run_id) {
      return json(200, recordExample);
    }
    const run = load<MockRun[]>(STORE, []).find((r) => r.id === id);
    if (!run) return error(404, "not_found", "No run has this id.");
    const record = snapshot(run);
    if (record.status === "failed" && !load<string[]>("mock:refunded", []).includes(run.id)) {
      spend(run.sub, -1);
      save("mock:refunded", [...load<string[]>("mock:refunded", []), run.id]);
    }
    return json(200, record);
  }
  return error(404, "not_found", `No mock for ${method} ${path}.`);
}

export function installMockApi(): void {
  const real = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(request ? request.url : String(input), window.location.origin);
    if (url.origin === window.location.origin && (url.pathname.startsWith("/api/") || url.pathname === MOCK_S3)) {
      return handle(url, init, request);
    }
    return real(input, init);
  };
  console.info("[batteryplan] API mock installed: /api is served from contracts/examples.");
}
