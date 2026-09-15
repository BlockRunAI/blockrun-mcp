// Run with: npm test  (tsx --test)
//
// The account rail reports what the gateway SETTLED, not what we guessed.
//
// blockrun_image used to route the account rail through the SDK's ImageClient,
// which parses the body and drops the Response — so `x-blockrun-cost-usd` was
// unreadable and the tool fell back to `estimateCost`. That estimate is high by
// construction: it adds the $0.001 transaction fee the account rail does not
// charge. Measured against the gateway on 2026-09-05, a nano-banana image
// settles at $0.052500 against a $0.0535 estimate.
//
// Two properties are pinned here, and they are the same two that make the cost
// header safe to read at all:
//
//   header present → use it, and stop calling the number an estimate
//   header ABSENT  → fall back to the estimate and keep saying so. Absent is
//                    "nothing settled at response time", never "free": booking
//                    $0 against a call that was genuinely billed is the failure
//                    this whole mechanism exists to prevent.
//
// Audit round 3 added the shape of the WIRE: the account gateway answers 202 +
// poll_url for any render past its 30s inline window (the default gpt-image-2,
// every edit), and the single-POST helper this rail used until then handed
// that envelope back as the image — "No image URL in response", job id and
// poll_url dropped, the render orphaned, and the agent's retry submitting
// another. So the real utils/api-key-call.ts runs here over a scripted
// fetchWithTimeout, and the 202 path is driven end to end.
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { BudgetState } from "../src/types.js";

function headers(map: Record<string, string> = {}) {
  const lower = Object.fromEntries(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name: string) => lower[name.toLowerCase()] ?? null };
}

// Scripted wire: each fetch shifts one response; an empty script means the
// test expected NO further network call. `requests` records what was sent.
let script: Array<() => unknown> = [];
const requests: Array<{ url: string; method: string }> = [];
mock.module("../src/utils/http.js", {
  namedExports: {
    fetchWithTimeout: async (url: string, init: { method?: string }) => {
      requests.push({ url, method: init.method ?? "GET" });
      const next = script.shift();
      if (!next) throw new Error("UNEXPECTED_NETWORK_CALL");
      return next();
    },
    isTimeoutError: (err: unknown) => {
      const name = err instanceof Error ? err.name : "";
      if (name === "AbortError" || name === "TimeoutError") return true;
      const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
      return msg.includes("abort") || msg.includes("timeout") || msg.includes("timed out") || msg.includes("did not complete within");
    },
  },
});
// A movable clock, so the poll deadline can pass without five minutes of
// real time.
const realNow = Date.now;
let clockOffset = 0;
mock.method(Date, "now", () => realNow() + clockOffset);

const inline200 = (cost: number | null) => () => ({
  status: 200, ok: true,
  headers: headers(cost === null ? {} : { "x-blockrun-cost-usd": cost.toFixed(6), "x-payment-receipt": "credit:test" }),
  json: async () => ({ data: [{ url: "https://blockrun.ai/media/fake.png" }] }),
});
const queued202 = () => ({
  status: 202, ok: true,
  headers: headers(),
  json: async () => ({ id: "img_42", status: "queued", poll_url: "/api/v1/images/generations/img_42" }),
});
const poll = (status: number, body: unknown, extra: Record<string, string> = {}) => () => ({
  status, ok: status >= 200 && status < 300, headers: headers(extra), json: async () => body,
});
const abortError = () => { const e = new Error("This operation was aborted"); e.name = "AbortError"; return e; };

// Drive account mode through the env var rather than mocking auth.js: the mode
// is derived from BLOCKRUN_API_KEY, and replacing that module wholesale drops
// exports other modules import (onramp.ts wants PORTAL_CREDITS_URL).
process.env.BLOCKRUN_API_KEY = "brk_live_testkeyfortestsonly0000";

mock.module("../src/utils/wallet.js", {
  namedExports: {
    getApiBase: () => "https://api.blockrun.ai",
    // The real resolver's shape: the gateway hands back a root-relative
    // /api/v1/... path and the account API serves /v1/... at its root.
    resolveGatewayUrl: (u: string) => (u.startsWith("http") ? u : `https://api.blockrun.ai${u.startsWith("/api/") ? u.slice(4) : u}`),
    getChain: () => "solana", // account rail must win over this, not read a key
    getImageClient: () => {
      throw new Error("account rail must NOT go through the SDK ImageClient");
    },
    getOrCreateWalletKey: () => {
      throw new Error("account rail must not touch a wallet key");
    },
    getWalletInfo: async () => ({ address: "0xTEST" }),
    resolveSolanaKey: () => undefined,
  },
});

const { registerImageTool } = await import("../src/tools/image.js");

function makeHarness() {
  let handler: ((args: Record<string, unknown>) => Promise<any>) | undefined;
  const server = {
    registerTool: (_name: string, _cfg: unknown, h: any) => {
      handler = h;
    },
    server: { getClientCapabilities: () => ({}) },
  } as any;
  const budget: BudgetState = { limit: null, spent: 0, calls: 0, agents: new Map() };
  registerImageTool(server, budget);
  return { call: (args: Record<string, unknown>) => handler!(args), budget };
}

beforeEach(() => { script = []; requests.length = 0; clockOffset = 0; });

test("account rail reports the SETTLED cost, not the estimate", async () => {
  script = [inline200(0.0525)];
  const { call, budget } = makeHarness();
  const res = await call({ prompt: "a red cube", model: "google/nano-banana" });
  const text = res.content.map((c: any) => c.text).join("\n");

  // The settled figure, and NOT flagged as an estimate — calling a number that
  // reconciles exactly "estimated" invites someone to discount it.
  assert.match(text, /Cost: \$0\.0525/);
  assert.doesNotMatch(text, /estimated/);
  assert.equal(res.structuredContent.cost_usd, 0.0525);
  assert.equal(res.structuredContent.cost_is_estimate, false);
  assert.equal(budget.spent, 0.0525, "the ledger books the header, once");
});

test("account rail does not go through the SDK or touch a wallet", async () => {
  // getImageClient and getOrCreateWalletKey both throw in this harness, so
  // reaching either fails the test rather than silently working.
  script = [inline200(0.0525)];
  const { call } = makeHarness();
  const res = await call({ prompt: "a red cube", model: "google/nano-banana" });
  assert.equal(res.isError, undefined);
  assert.equal(requests.length, 1, "expected the account rail to POST directly");
  assert.equal(requests[0].url, "https://api.blockrun.ai/v1/images/generations");
});

test("an absent settled cost falls back to the estimate and still says so", async () => {
  // paidUsd null means the rail settled nothing at response time. It must not
  // be booked as $0.
  script = [inline200(null)];
  const { call, budget } = makeHarness();
  const res = await call({ prompt: "a red cube", model: "google/nano-banana" });
  const text = res.content.map((c: any) => c.text).join("\n");

  assert.match(text, /estimated/);
  assert.equal(res.structuredContent.cost_is_estimate, true);
  assert.ok(res.structuredContent.cost_usd > 0, "must not book a null as $0");
  assert.ok(budget.spent > 0, "the ledger must not record zero for a billed call");
});

test("a render past the inline window (202 + poll_url) is polled to completion and returned", async () => {
  // The default gpt-image-2 routinely exceeds the gateway's 30s window. Until
  // audit round 3 this rail took the 202 envelope as the image and returned
  // "No image URL in response" with the job discarded.
  script = [
    queued202,
    poll(202, { id: "img_42", status: "in_progress" }),
    poll(200, { id: "img_42", status: "completed", data: [{ url: "https://blockrun.ai/media/img_42.png" }] }, { "x-blockrun-cost-usd": "0.063000" }),
  ];
  const { call, budget } = makeHarness();
  const res = await call({ prompt: "a red cube", model: "openai/gpt-image-2", size: "1024x1024" });
  const text = res.content.map((c: any) => c.text).join("\n");
  assert.notEqual(res.isError, true, text);
  assert.match(text, /Image: https:\/\/blockrun\.ai\/media\/img_42\.png/);
  assert.doesNotMatch(text, /No image URL/);
  assert.equal(res.structuredContent.url, "https://blockrun.ai/media/img_42.png");
  // The poll went to the ACCOUNT API root (resolveGatewayUrl), not to a
  // string-concatenated /api/v1 on the wallet gateway.
  assert.equal(requests[1].url, "https://api.blockrun.ai/v1/images/generations/img_42");
  assert.equal(requests[1].method, "GET");
  assert.equal(budget.spent, 0.063, "booked from the completed poll's cost header, once");
  assert.equal(script.length, 0);
});

test("a 202 render that never completes is booked, names the job, and does not invite a second submit", async () => {
  script = [
    queued202,
    () => { clockOffset += 3_600_000; return poll(202, { id: "img_42", status: "in_progress" })(); },
  ];
  const { call, budget } = makeHarness();
  const res = await call({ prompt: "a red cube", model: "openai/gpt-image-2", size: "1024x1024" });
  const text = res.content.map((c: any) => c.text).join("\n");
  assert.equal(res.isError, true, text);
  assert.match(text, /job img_42/);
  assert.match(text, /dashboard\/activity/);
  assert.match(text, /bills a second render/);
  assert.doesNotMatch(text, /No image URL/);
  assert.doesNotMatch(text, /No payment was taken/);
  // No cost header on the 202: the estimate is booked, never $0.
  assert.equal(budget.spent, 0.065, `spent=${budget.spent}`);
});

test("a submit that never answers MAY have been accepted: booked and said so", async () => {
  // 0.50.0 cleared the in-flight flag in a `.finally` on this rail, so an
  // abort after the Bearer went out returned a plain "failed" with $0 booked.
  script = [() => { throw abortError(); }];
  const { call, budget } = makeHarness();
  const res = await call({ prompt: "a red cube", model: "google/nano-banana" });
  const text = res.content.map((c: any) => c.text).join("\n");
  assert.equal(res.isError, true, text);
  assert.match(text, /MAY have been accepted/);
  assert.match(text, /dashboard\/activity/);
  assert.doesNotMatch(text, /No payment was taken/);
  assert.equal(budget.spent, 0.054501, "the estimate is booked conservatively");
});

test("an out-of-credit 402 on this rail is a funding answer, not a maybe, and books nothing", async () => {
  script = [poll(402, { error: "insufficient credit" })];
  const { call, budget } = makeHarness();
  const res = await call({ prompt: "a red cube", model: "google/nano-banana" });
  const text = res.content.map((c: any) => c.text).join("\n");
  assert.equal(res.isError, true);
  assert.match(text, /out of credit/);
  assert.doesNotMatch(text, /MAY have/);
  assert.equal(budget.spent, 0);
});

// Audit round 4: the account rail is NOT wrapped in the in-flight tracker —
// apiKeyAsyncPost classifies every post-submit exit itself (BilledJobError,
// JobFailedError), and arming the tracker around it made a not_charged
// terminal failure whose upstream text said "timeout" read as "MAY have
// settled": budget.spent += a whole render and the text told the user to
// check the dashboard before retrying a job the gateway had just said cost
// nothing. video and music documented exactly this; image did the opposite.
test("a not_charged terminal failure whose text says 'timeout' books nothing and says so", async () => {
  script = [
    queued202,
    poll(200, { status: "failed", error: "The operation was aborted due to timeout", payment_status: "not_charged", note: "No payment was taken." }),
  ];
  const { call, budget } = makeHarness();
  const res = await call({ prompt: "a cube", model: "google/nano-banana", size: "1024x1024" });
  assert.equal(res.isError, true);
  assert.equal(budget.spent, 0, "the gateway said not_charged — nothing is booked");
  assert.match(res.content[0].text, /No payment was taken/);
  assert.doesNotMatch(res.content[0].text, /MAY have/);
  assert.doesNotMatch(res.content[0].text, /booked against your budget/);
});

test("a 500 that ARRIVED on submit is the gateway's answer — nothing is booked as 'may have settled'", async () => {
  script = [poll(500, { error: "Upstream timeout" })];
  const { call, budget } = makeHarness();
  const res = await call({ prompt: "a cube", model: "google/nano-banana", size: "1024x1024" });
  assert.equal(res.isError, true);
  assert.equal(budget.spent, 0);
  // formatError's hedge for a 5xx after the key was sent is text only, by
  // design; what must not happen is the in-flight BOOKING sentence.
  assert.doesNotMatch(res.content[0].text, /booked against your budget/);
  assert.doesNotMatch(res.content[0].text, /got no answer/);
});

// Round 4b: an EDGE 504 on the submit is not the gateway's answer — the
// origin may have accepted the render and be billing it. The account helper
// classifies it as an unknown billing, and the tool books the estimate and
// says so.
test("a 504 from the EDGE on submit is an unknown billing: booked, and the text says MAY", async () => {
  script = [poll(504, { error: "upstream request timeout" })];
  const { call, budget } = makeHarness();
  const res = await call({ prompt: "a cube", model: "google/nano-banana", size: "1024x1024" });
  assert.equal(res.isError, true);
  assert.ok(budget.spent > 0, `spent=${budget.spent}`);
  assert.match(res.content[0].text, /MAY have been accepted/);
  assert.match(res.content[0].text, /dashboard\/activity/);
});

test("a 202 whose body carries no poll_url is a BILLED job, not a plain error", async () => {
  script = [() => ({ status: 202, ok: true, headers: headers({ "x-blockrun-cost-usd": "0.052500" }), json: async () => ({ id: "img_43", status: "queued" }) })];
  const { call, budget } = makeHarness();
  const res = await call({ prompt: "a cube", model: "google/nano-banana", size: "1024x1024" });
  assert.equal(res.isError, true);
  assert.equal(budget.spent, 0.0525, "the submit was accepted and billed; the ledger carries it");
  assert.match(res.content[0].text, /img_43/);
  assert.match(res.content[0].text, /bills a second render/);
});
