// The HTTP API of contracts/platform.md. Errors come back as
// {"error": {"code", "message"}}, the message written for the user.
import type { Me, RunCreated, RunRecord, RunRequest, UploadTicket } from "../contracts/types";
import { messages } from "../i18n";
import { localizeServerMessage } from "../i18n/server";
import { sha256Hex } from "./sha256";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** Seconds, from Retry-After, on a 429. */
  readonly retryAfter: number | null;
  readonly body: unknown;

  constructor(status: number, code: string, message: string, retryAfter: number | null, body: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
    this.body = body;
  }
}

/** undefined: a public route; null or a string: a route that needs the bearer token. */
type Token = string | null | undefined;

async function request<T>(method: string, path: string, body?: unknown, token?: Token): Promise<{ status: number; data: T }> {
  const headers: Record<string, string> = { Accept: "application/json" };
  // Serialised once: the hash is of exactly the bytes that are sent.
  const payload = body === undefined ? undefined : new TextEncoder().encode(JSON.stringify(body));
  if (payload !== undefined) {
    headers["Content-Type"] = "application/json";
    // CloudFront signs the request to the Lambda Function URL with OAC (SigV4)
    // and cannot hash a body itself: the viewer sends the payload's hash.
    headers["x-amz-content-sha256"] = await sha256Hex(payload.buffer as ArrayBuffer);
  }
  if (token !== undefined) {
    if (!token) throw new ApiError(401, "unauthorized", "Sign in to continue.", null, null);
    // Not Authorization: behind CloudFront, OAC replaces it with its own
    // signature. The API reads X-Authorization first.
    headers["X-Authorization"] = `Bearer ${token}`;
  }
  let response: Response;
  try {
    response = await fetch(path, { method, headers, body: payload });
  } catch {
    throw new ApiError(0, "network", "Could not reach the server. Check your connection and try again.", null, null);
  }
  const text = await response.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) {
    const error = (data as { error?: { code?: string; message?: string } } | null)?.error;
    const retry = response.headers.get("Retry-After");
    const err = new ApiError(
      response.status,
      error?.code ?? `http_${response.status}`,
      error?.message ?? `The server answered ${response.status}.`,
      retry !== null && retry !== "" && Number.isFinite(Number(retry)) ? Number(retry) : null,
      data,
    );
    throw err;
  }
  if (data === null && text) {
    throw new ApiError(response.status, "bad_response", "The server sent something that is not JSON.", null, text);
  }
  return { status: response.status, data: data as T };
}

export const api = {
  me: async (token: string | null) => (await request<Me>("GET", "/api/me", undefined, token)).data,
  createUpload: async (token: string | null, sha256: string, size: number) =>
    (await request<UploadTicket>("POST", "/api/uploads", { sha256, size }, token)).data,
  createRun: async (token: string | null, body: RunRequest) =>
    (await request<RunCreated>("POST", "/api/runs", body, token)).data,
  getRun: async (runId: string) =>
    (await request<RunRecord>("GET", `/api/runs/${encodeURIComponent(runId)}`)).data,
};

/** The presigned POST: the returned fields first, the file last, as S3 requires. */
export async function uploadToPresigned(ticket: UploadTicket, file: Blob, name: string): Promise<void> {
  const form = new FormData();
  for (const [key, value] of Object.entries(ticket.fields)) form.append(key, value);
  form.append("file", file, name);
  let response: Response;
  try {
    response = await fetch(ticket.url, { method: "POST", body: form });
  } catch {
    throw new ApiError(0, "upload_failed", "The upload could not reach storage. Try again.", null, null);
  }
  // Read the body even on success: an unread 204 shows as an aborted request
  // in the network panel.
  const text = await response.text().catch(() => "");
  if (!response.ok) {
    const tooLarge = /EntityTooLarge/.test(text);
    throw new ApiError(
      response.status,
      "upload_failed",
      tooLarge ? "The file is larger than 5 MB." : `Storage refused the upload (${response.status}).`,
      null,
      text,
    );
  }
}

function untilLabel(seconds: number): string {
  const t = messages().errors;
  if (seconds < 90) return t.seconds(Math.max(1, Math.round(seconds)));
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t.minutes(minutes);
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} min`;
}

/** What to tell the user about a failed call: a title and a sentence they can act on. */
export function describeError(error: unknown): { title: string; detail: string } {
  const t = messages().errors;
  if (!(error instanceof ApiError)) {
    return { title: t.generic, detail: error instanceof Error ? error.message : String(error) };
  }
  const wait = error.retryAfter !== null ? untilLabel(error.retryAfter) : null;
  const detail = localizeServerMessage(error.message);
  switch (error.code) {
    case "quota_exceeded":
      return { title: t.quotaTitle, detail: t.quotaDetail(wait) };
    case "global_cap":
      return { title: t.capTitle, detail: t.capDetail(wait) };
    case "rate_limited":
      return { title: t.rateTitle, detail: t.rateDetail(wait ?? t.aMinute) };
    case "unauthorized":
      return { title: t.authTitle, detail: t.authDetail };
    case "request_invalid":
      return { title: t.requestTitle, detail };
    case "prices_invalid":
      return { title: t.pricesTitle, detail };
    case "not_found":
      return { title: t.notFoundTitle, detail: t.notFoundDetail };
    case "unavailable":
      return { title: t.unavailableTitle, detail: t.unavailableDetail };
    default:
      return { title: error.status ? t.status(error.status) : t.network, detail };
  }
}
