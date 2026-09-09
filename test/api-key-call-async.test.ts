// Run with: npm test  (tsx --experimental-test-module-mocks --test)
//
// Drives apiKeyAsyncPost against a scripted fetch. This is the one rail where the
// money is gone at SUBMIT — the gateway bills an async media job the moment it
// answers 202, and the polls are free — so every exit after a successful submit
// has to carry two things the wallet rails never need: the fact that the job is
// already billed (with its id), and the cost the submit response reported, so
// the caller can book it. Before this file existed nothing drove the function;
// image-account-cost.test.ts mocks the module out entirely.
import { test, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.BLOCKRUN_API_KEY = "brk_live_testkeyfortestsonly0000";

function headers(map: Record<string, string> = {}) {
  const lower = Object.fromEntries(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name: string) => lower[name.toLowerCase()] ?? null };
}

type Scripted = { url: string; method: string; timeoutMs: number };
let script: Array<() => unknown> = [];
let requests: Scripted[] = [];
mock.module("../src/utils/http.js", {
  namedExports: {
    fetchWithTimeout: async (url: string, init: { method?: string }, timeoutMs: number) => {
      requests.push({ url, method: init.method || "GET", timeoutMs });
      const next = script.shift();
      if (!next) throw new Error("UNEXPECTED_NETWORK_CALL");
      return next();
    },
  },
});
mock.module("../src/utils/wallet.js", {
  namedExports: {
    getApiBase: () => "https://api.blockrun.ai",
    resolveGatewayUrl: (u: string) => (u.startsWith("http") ? u : `https://api.blockrun.ai${u.startsWith("/api/") ? u.slice(4) : u}`),
  },
});

const { apiKeyAsyncPost, BilledJobError } = await import("../src/utils/api-key-call.js");

beforeEach(() => { script = []; requests = []; });
afterEach(() => { assert.equal(script.length, 0, "unconsumed scripted responses"); });

const POLL = "/api/v1/videos/generations/job_1";
const submit = (cost: string | null = "9.450000") => ({
  status: 202, ok: true,
  headers: headers(cost === null ? {} : { "x-blockrun-cost-usd": cost }),
  json: async () => ({ id: "job_1", poll_url: POLL, status: "queued" }),
});
const poll = (status: string, extra: Record<string, unknown> = {}, http = status === "completed" ? 200 : 202) => ({
  status: http, ok: http >= 200 && http < 300, headers: headers(),
  json: async () => ({ status, ...extra }),
});
const statusOnly = (http: number, hdrs: Record<string, string> = {}, body: Record<string, unknown> = {}) => ({
  status: http, ok: false, headers: headers(hdrs), json: async () => body,
});
const abortError = () => { const e = new Error("This operation was aborted"); e.name = "AbortError"; return e; };
const fast = { pollBudgetMs: 10_000, pollIntervalMs: 1 };
const gets = () => requests.filter((r) => r.method === "GET");

// ---------------------------------------------------------------------------
// Transient poll trouble keeps polling — the job is paid for.
// ---------------------------------------------------------------------------

test("a poll fetch that rejects is retried inside the deadline, not fatal", async () => {
  script = [
    submit,
    () => { throw new TypeError("fetch failed"); },
    () => { throw abortError(); },
    () => poll("in_progress"),
    () => poll("completed", { data: [{ url: "https://blockrun.ai/media/job_1.mp4" }] }),
  ];
  const result = await apiKeyAsyncPost("/v1/videos/generations", { prompt: "t" }, fast);
  assert.equal(result.jobId, "job_1");
  assert.equal(result.paidUsd, 9.45, "the cost rides the submit response");
  assert.equal((result.data.data as Array<{ url: string }>)[0].url, "https://blockrun.ai/media/job_1.mp4");
  assert.equal(gets().length, 4);
  assert.equal(gets()[0].url, `https://api.blockrun.ai/v1/videos/generations/job_1`, "poll URL resolves onto the account API, not the wallet gateway");
});

test("transient proxy statuses on a poll (429/502/503/504/522/524) keep polling", async () => {
  script = [
    submit,
    () => statusOnly(503),
    () => statusOnly(429, { "retry-after": "0" }),
    () => statusOnly(502),
    () => statusOnly(504),
    () => statusOnly(522),
    () => statusOnly(524),
    () => poll("completed", { data: [{ url: "u" }] }),
  ];
  const result = await apiKeyAsyncPost("/v1/audio/generations", { prompt: "t" }, fast);
  assert.equal(result.jobId, "job_1");
  assert.equal(gets().length, 7);
});

// ---------------------------------------------------------------------------
// Every give-up after submit is a BilledJobError carrying the cost and the id.
// ---------------------------------------------------------------------------

test("the deadline throw carries the submit cost and the job id, and keeps its message", async () => {
  script = [submit];
  await assert.rejects(
    apiKeyAsyncPost("/v1/videos/generations", { prompt: "t" }, { pollBudgetMs: 0, pollIntervalMs: 1 }),
    (err: unknown) => {
      assert.ok(err instanceof BilledJobError, `expected BilledJobError, got ${String(err)}`);
      assert.equal(err.paidUsd, 9.45);
      assert.equal(err.jobId, "job_1");
      assert.equal(err.billing, "billed");
      // Unchanged text: isTimeoutError and the wallet-rail message tests key on it.
      assert.match(err.message, /Job did not complete within 0s \(last status: queued\)/);
      assert.match(err.message, /already been billed to the account; job id job_1/);
      assert.match(err.message, /dashboard\/activity before submitting again/);
      return true;
    },
  );
});

test("an absent cost header leaves paidUsd null (the caller books its estimate), never zero", async () => {
  script = [() => submit(null)];
  await assert.rejects(
    apiKeyAsyncPost("/v1/audio/generations", { prompt: "t" }, { pollBudgetMs: 0, pollIntervalMs: 1 }),
    (err: unknown) => err instanceof BilledJobError && err.paidUsd === null && err.jobId === "job_1",
  );
});

test("a non-transient poll status abandons the job WITH the billed note and the cost", async () => {
  script = [submit, () => statusOnly(500, {}, { error: "boom" })];
  await assert.rejects(
    apiKeyAsyncPost("/v1/videos/generations", { prompt: "t" }, fast),
    (err: unknown) => {
      assert.ok(err instanceof BilledJobError, `expected BilledJobError, got ${String(err)}`);
      assert.match(err.message, /API error 500/);
      assert.match(err.message, /"boom"/, "the poll body still reaches the message");
      assert.match(err.message, /already been billed to the account; job id job_1/);
      assert.equal(err.paidUsd, 9.45);
      assert.equal(err.billing, "billed");
      return true;
    },
  );
});

test("a terminal failure the gateway says was NOT charged stays a plain error", async () => {
  script = [submit, () => poll("failed", { error: "render exploded", payment_status: "not_charged" })];
  await assert.rejects(
    apiKeyAsyncPost("/v1/videos/generations", { prompt: "t" }, fast),
    (err: unknown) => {
      assert.ok(!(err instanceof BilledJobError), "a refunded failure must not be booked");
      assert.match((err as Error).message, /render exploded.*No payment was taken/);
      return true;
    },
  );
});

test("a terminal failure with an explicit charged status is billed", async () => {
  script = [submit, () => poll("failed", { error: "render exploded", payment_status: "charged" })];
  await assert.rejects(
    apiKeyAsyncPost("/v1/videos/generations", { prompt: "t" }, fast),
    (err: unknown) => err instanceof BilledJobError && err.billing === "billed" && err.paidUsd === 9.45 && err.jobId === "job_1",
  );
});

test("a terminal failure with NO payment status is carried as unknown, still bookable", async () => {
  // The gateway contract is to emit payment_status on failures; when it does
  // not, we neither claim a refund we did not observe nor drop the cost.
  script = [submit, () => poll("failed", { error: "render exploded" })];
  await assert.rejects(
    apiKeyAsyncPost("/v1/videos/generations", { prompt: "t" }, fast),
    (err: unknown) => {
      assert.ok(err instanceof BilledJobError);
      assert.equal(err.billing, "unknown");
      assert.equal(err.paidUsd, 9.45);
      assert.match(err.message, /Billing status: unknown/);
      assert.match(err.message, /for job job_1/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// The submit itself: no response is not "not billed".
// ---------------------------------------------------------------------------

test("a submit that aborts says the job MAY have been billed — it does not claim a charge, and does not say retry", async () => {
  script = [() => { throw abortError(); }];
  await assert.rejects(
    apiKeyAsyncPost("/v1/videos/generations", { prompt: "t" }, fast),
    (err: unknown) => {
      assert.ok(err instanceof BilledJobError, `expected BilledJobError, got ${String(err)}`);
      assert.equal(err.billing, "unknown");
      assert.equal(err.paidUsd, null);
      assert.equal(err.jobId, undefined);
      assert.match(err.message, /did not return a response/);
      assert.match(err.message, /MAY have been accepted and billed/);
      assert.match(err.message, /dashboard\/activity before submitting again/);
      assert.doesNotMatch(err.message, /already been billed/, "no charge was observed, so none is asserted");
      return true;
    },
  );
});

test("a submit that never reached the gateway (DNS / refused) is rethrown as-is — nothing could have been billed", async () => {
  for (const code of ["ENOTFOUND", "ECONNREFUSED", "EAI_AGAIN"]) {
    script = [() => { const e = new TypeError("fetch failed"); (e as Error & { cause?: unknown }).cause = { code }; throw e; }];
    await assert.rejects(
      apiKeyAsyncPost("/v1/videos/generations", { prompt: "t" }, fast),
      (err: unknown) => !(err instanceof BilledJobError) && err instanceof TypeError && err.message === "fetch failed",
      `cause ${code} must not be reported as a possible charge`,
    );
  }
});
