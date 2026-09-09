// Run with: npm test  (tsx --experimental-test-module-mocks --test)
//
// Pins the three money-path holes the 0.38.1 review documented as "known and
// unfixed", now fixed:
//
//  1. An unquotable 402 amount must abort BEFORE any payment is signed — the
//     old path skipped the re-reserve, signed the raw unvalidated amount, and
//     booked only the estimate: the last remaining way past the budget cap.
//  2. image_url / last_frame_url get the same SSRF guard blockrun_image has —
//     scheme check plus resolved-host check, BEFORE any network call, so a
//     private/metadata address is never forwarded to (or paid for at) the
//     gateway.
//  3. Settlement happens server-side on the first "completed" poll. The spend
//     must be booked the moment that status is observed — a malformed
//     completed payload used to throw first, releasing the reservation while
//     the USDC was already gone.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import type { BudgetState } from "../src/types.js";

const TEST_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

function headers(map: Record<string, string>) {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) lower[k.toLowerCase()] = v;
  return { get: (name: string) => lower[name.toLowerCase()] ?? null };
}

// Scriptable fetch: each test sets `script` to the remaining responses; every
// call shifts one. Empty script = the test expected NO network call.
let script: Array<() => unknown> = [];
let fetchCalls = 0;
mock.module("../src/utils/http.js", {
  namedExports: {
    fetchWithTimeout: async () => {
      fetchCalls++;
      const next = script.shift();
      if (!next) throw new Error("UNEXPECTED_NETWORK_CALL");
      return next();
    },
    // The real predicate, restated: the deadline cases below depend on the
    // "did not complete within" message being classified as a timeout.
    isTimeoutError: (err: unknown) => {
      const name = err instanceof Error ? err.name : "";
      if (name === "AbortError" || name === "TimeoutError") return true;
      const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
      return msg.includes("abort") || msg.includes("timeout") || msg.includes("timed out") || msg.includes("did not complete within");
    },
  },
});
// A movable clock. Jumping it past VIDEO_TOTAL_BUDGET_MS from inside a scripted
// poll ends the loop on the next check, so the deadline paths run without
// sitting through nine minutes of real time.
const realNow = Date.now;
let clockOffset = 0;
mock.method(Date, "now", () => realNow() + clockOffset);
mock.module("../src/utils/wallet.js", {
  namedExports: {
    getApiBase: () => "https://blockrun.ai/api",
    resolveGatewayUrl: (u: string) => (u.startsWith("http") ? u : `https://blockrun.ai/api${u.startsWith("/api/") ? u.slice(4) : u}`),

    getChain: () => "base",
    getOrCreateWalletKey: () => TEST_KEY,
    getWalletInfo: async () => ({ address: "0xTEST" }),
  },
});
// Hostname-keyed, no DNS: the real resolver is covered by ssrf.test.ts; here we
// only need "this hostname is private" to be decidable offline.
mock.module("../src/utils/ssrf.js", {
  namedExports: {
    isBlockedFetchHostResolved: async (hostname: string) =>
      hostname === "169.254.169.254" || hostname === "127.0.0.1.nip.io",
    isBlockedFetchHost: () => false,
  },
});
// Scriptable 402 amount + a payment-signing tripwire.
let quotedAmount: unknown = "400000";
let paymentsSigned = 0;
mock.module("@blockrun/llm", {
  namedExports: {
    createPaymentPayload: async () => { paymentsSigned++; return "0xpaymentpayloadmock"; },
    parsePaymentRequired: () => ({}),
    extractPaymentDetails: () => ({
      amount: quotedAmount,
      recipient: "0x0000000000000000000000000000000000000001",
      network: "eip155:8453",
      resource: { url: "https://blockrun.ai/api/v1/videos/generations", description: "BlockRun Video Generation" },
      maxTimeoutSeconds: 600,
      extra: {},
    }),
  },
});

const { registerVideoTool } = await import("../src/tools/video.js");

function makeHarness() {
  let handler: ((args: Record<string, unknown>) => Promise<any>) | undefined;
  const server = {
    registerTool: (_n: string, _c: unknown, h: any) => { handler = h; },
    server: { getClientCapabilities: () => ({}) },
  } as any;
  const budget: BudgetState = { limit: null, spent: 0, calls: 0, agents: new Map() };
  registerVideoTool(server, budget);
  return { call: (args: Record<string, unknown>) => handler!(args), budget };
}

const resp402 = () => ({ status: 402, ok: false, headers: headers({ "payment-required": "x402 base ..." }), json: async () => ({}) });
const respSubmit = () => ({ status: 202, ok: false, headers: headers({}), json: async () => ({ id: "vid_1", poll_url: "/api/v1/videos/poll/vid_1", status: "queued" }) });
const respPoll = (body: unknown) => ({ status: 200, ok: true, headers: headers({}), json: async () => body });

test("SSRF: non-http(s) schemes and private-resolving hosts are refused before ANY network call", async () => {
  for (const args of [
    { image_url: "file:///etc/passwd" },
    { image_url: "http://169.254.169.254/latest/meta-data/" },
    { image_url: "https://127.0.0.1.nip.io/a.png" },
    { image_url: "https://ok.example.com/a.png", last_frame_url: "http://169.254.169.254/b.png" },
  ]) {
    script = []; fetchCalls = 0;
    const { call, budget } = makeHarness();
    const res = await call({ prompt: "a cube", model: "bytedance/seedance-2.0", ...args });
    const text = res.content.map((c: any) => c.text).join("\n");
    assert.equal(res.isError, true, text);
    assert.match(text, /http\(s\) URL|private\/loopback\/link-local/);
    assert.equal(fetchCalls, 0, `network was reached for ${JSON.stringify(args)}`);
    assert.equal(budget.spent, 0);
  }
});

test("SSRF: a public https seed image still goes through", async () => {
  script = [resp402, respSubmit, () => respPoll({ status: "completed", data: [{ url: "https://blockrun.ai/media/vid_1.mp4", duration_seconds: 5 }] })];
  quotedAmount = "400000";
  const { call } = makeHarness();
  const res = await call({ prompt: "a cube", model: "bytedance/seedance-2.0", image_url: "https://ok.example.com/a.png" });
  assert.notEqual(res.isError, true, res.content?.[0]?.text);
});

test("an unreadable 402 amount aborts BEFORE signing — nothing signed, nothing booked", async () => {
  for (const bad of ["garbage", "", "-5", 0, undefined, {}]) {
    script = [resp402]; fetchCalls = 0; paymentsSigned = 0;
    quotedAmount = bad;
    const { call, budget } = makeHarness();
    const res = await call({ prompt: "a cube", model: "xai/grok-imagine-video" });
    const text = res.content.map((c: any) => c.text).join("\n");
    assert.equal(res.isError, true, text);
    assert.match(text, /unreadable amount/);
    assert.match(text, /no charge was made/);
    assert.equal(paymentsSigned, 0, `signed a payment for amount ${JSON.stringify(bad)}`);
    assert.equal(fetchCalls, 1, "must stop after the quote — no paid submit");
    assert.equal(budget.spent, 0, "reservation must be fully released");
  }
  quotedAmount = "400000";
});

test("a malformed completed poll still BOOKS the settled spend (the money already moved)", async () => {
  // Poll answers completed with an empty data[] — the old path threw on the
  // missing URL, the catch returned an error, and finally released the
  // reservation: $0.40 gone on-chain, $0 in the ledger.
  script = [resp402, respSubmit, () => respPoll({ status: "completed", data: [] })];
  quotedAmount = "400000";
  const { call, budget } = makeHarness();
  const res = await call({ prompt: "a cube", model: "xai/grok-imagine-video" });
  const text = res.content.map((c: any) => c.text).join("\n");
  assert.equal(res.isError, true, "a payload with no clip URL is still an error for the caller");
  assert.match(text, /missing video URL/);
  assert.ok(Math.abs(budget.spent - 0.4) < 1e-9, `settled charge must stay booked: spent=${budget.spent}`);
});

test("the happy path books the settled amount exactly once", async () => {
  script = [resp402, respSubmit, () => respPoll({ status: "completed", data: [{ url: "https://blockrun.ai/media/vid_1.mp4", duration_seconds: 8 }] })];
  quotedAmount = "400000";
  const { call, budget } = makeHarness();
  const res = await call({ prompt: "a cube", model: "xai/grok-imagine-video" });
  assert.notEqual(res.isError, true, res.content?.[0]?.text);
  assert.equal(res.structuredContent.cost_usd, 0.4);
  assert.ok(Math.abs(budget.spent - 0.4) < 1e-9, `booked once, not twice: spent=${budget.spent}`);
});

test("upstream failure before completion books nothing (no charge per gateway contract)", async () => {
  script = [resp402, respSubmit, () => respPoll({ status: "failed", error: "render exploded" })];
  quotedAmount = "400000";
  const { call, budget } = makeHarness();
  const res = await call({ prompt: "a cube", model: "xai/grok-imagine-video" });
  assert.equal(res.isError, true);
  assert.equal(budget.spent, 0, "failed jobs are not charged and must not be booked");
});

test("a 402 far above the published rate is refused BEFORE signing — nothing signed, nothing booked", async () => {
  // Live 2026-09-08 shape: the Solana gateway quoted azure/sora-2 (4s, $0.4220
  // expected) as Seedance 2.0 Pro at $1.135480. Same guard on the Base rail.
  script = [resp402]; fetchCalls = 0; paymentsSigned = 0;
  quotedAmount = "1135480";
  const { call, budget } = makeHarness();
  const res = await call({ prompt: "a cube", model: "azure/sora-2" });
  const text = res.content.map((c: any) => c.text).join("\n");
  assert.equal(res.isError, true, text);
  assert.match(text, /quoted \$1\.1355 for azure\/sora-2 video/);
  assert.match(text, /expected about \$0\.4220/);
  assert.match(text, /no charge was made/);
  assert.doesNotMatch(text, /needs funding/, "a bad quote is not a funding problem");
  assert.equal(paymentsSigned, 0, "must not sign a quote it refused");
  assert.equal(fetchCalls, 1, "must stop after the quote — no paid submit");
  assert.equal(budget.spent, 0, "reservation must be fully released");
  quotedAmount = "400000";
});

test("a quote inside the tolerance still re-reserves and pays (4K renders exceed the estimate by design)", async () => {
  script = [resp402, respSubmit, () => respPoll({ status: "completed", data: [{ url: "https://blockrun.ai/media/vid_1.mp4", duration_seconds: 8 }] })];
  quotedAmount = "450000"; // $0.45 against a $0.40 estimate: 1.125x
  const { call, budget } = makeHarness();
  const res = await call({ prompt: "a cube", model: "xai/grok-imagine-video" });
  assert.notEqual(res.isError, true, res.content?.[0]?.text);
  assert.ok(Math.abs(budget.spent - 0.45) < 1e-9, `books the quote: spent=${budget.spent}`);
  quotedAmount = "400000";
});

// ---------------------------------------------------------------------------
// The Base poll loop: transient trouble is retried, and every give-up says
// whether money moved — and names the job, which stays claimable ~48h.
// ---------------------------------------------------------------------------

const respPoll202 = (status: string) => ({ status: 202, ok: true, headers: headers({}), json: async () => ({ status }) });
const abortError = () => { const e = new Error("This operation was aborted"); e.name = "AbortError"; return e; };

test("a transient poll rejection is retried inside the deadline, not fatal", async () => {
  // One ECONNRESET used to throw out of the loop after (potentially) eight
  // minutes of render, with no job id and no charge statement.
  clockOffset = 0;
  script = [resp402, respSubmit, () => { throw new TypeError("fetch failed"); }, () => respPoll({ status: "completed", data: [{ url: "https://blockrun.ai/media/vid_1.mp4", duration_seconds: 8 }] })];
  quotedAmount = "400000";
  const { call, budget } = makeHarness();
  const res = await call({ prompt: "a cube", model: "xai/grok-imagine-video" });
  assert.notEqual(res.isError, true, res.content?.[0]?.text);
  assert.ok(Math.abs(budget.spent - 0.4) < 1e-9, `booked once: spent=${budget.spent}`);
});

test("a paid poll still in flight at the deadline MAY have settled: say so, book conservatively, no 'try again'", async () => {
  // The gateway keeps going after a client disconnect — backup, then settle —
  // so the last clamped poll can settle server-side after we abort it.
  clockOffset = 0;
  script = [resp402, respSubmit, () => { clockOffset += 3_600_000; throw abortError(); }];
  quotedAmount = "400000";
  const { call, budget } = makeHarness();
  const res = await call({ prompt: "a cube", model: "xai/grok-imagine-video" });
  const text = res.content.map((c: any) => c.text).join("\n");
  assert.equal(res.isError, true, text);
  assert.match(text, /MAY have settled/);
  assert.match(text, /blockrun_wallet action:"report"/);
  assert.match(text, /claimable.*job vid_1/);
  assert.doesNotMatch(text, /please try again/);
  assert.doesNotMatch(text, /No payment was taken/, "a possible settlement is not a known refund");
  assert.ok(Math.abs(budget.spent - 0.4) < 1e-9, `booked conservatively: spent=${budget.spent}`);
  clockOffset = 0;
});

test("the deadline with the last poll answered: no charge, the job id, and no 'try again'", async () => {
  clockOffset = 0;
  script = [resp402, respSubmit, () => { clockOffset += 3_600_000; return respPoll202("in_progress"); }];
  quotedAmount = "400000";
  const { call, budget } = makeHarness();
  const res = await call({ prompt: "a cube", model: "xai/grok-imagine-video" });
  const text = res.content.map((c: any) => c.text).join("\n");
  assert.equal(res.isError, true, text);
  assert.match(text, /did not complete within 540s \(last status: in_progress\)/);
  assert.match(text, /No payment was taken/);
  assert.match(text, /claimable.*job vid_1/);
  assert.match(text, /would start and charge a new job/);
  assert.doesNotMatch(text, /please try again/);
  assert.equal(budget.spent, 0, "an answered poll that did not complete settles nothing");
  clockOffset = 0;
});
