import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";

afterEach(() => vi.unstubAllGlobals());

function capture() {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ run_id: "r", status: "queued", cached: false, sub: "s", email: null }), { status: 200 });
  });
  return calls;
}

describe("api requests behind CloudFront OAC", () => {
  it("sends the bearer in X-Authorization and the body's sha256", async () => {
    const calls = capture();
    await api.createUpload("dev:u:u@x", "a".repeat(64), 10);
    const { init } = calls[0];
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Authorization"]).toBe("Bearer dev:u:u@x");
    expect(headers.Authorization).toBeUndefined();
    const sent = Buffer.from(init.body as Uint8Array);
    expect(JSON.parse(sent.toString("utf8"))).toEqual({ sha256: "a".repeat(64), size: 10 });
    expect(headers["x-amz-content-sha256"]).toBe(createHash("sha256").update(sent).digest("hex"));
  });

  it("sends no payload hash without a body", async () => {
    const calls = capture();
    await api.me("dev:u:");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["x-amz-content-sha256"]).toBeUndefined();
    expect(calls[0].init.body).toBeUndefined();
  });
});
