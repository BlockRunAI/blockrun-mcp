// Run with: npm test  (tsx --experimental-test-module-mocks --test)
//
// blockrun_video and blockrun_music on the ACCOUNT rail, driven through the real
// handlers with the HTTP layer scripted. The account rail bills an async job at
// submit, so when the job then times out or fails the tool has two duties the
// wallet rails do not: book the charge in the local ledger (the reservation is
// released in finally, so without a booking the cap silently rises by the whole
// clip price), and never tell the caller to "try again" — that submits and bills
// a second job. Both were missing; isTimeoutError matched the deadline message
// and glued "please try again" onto a note saying the job was billed.
import { test, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { BudgetState } from "../src/types.js";

process.env.BLOCKRUN_API_KEY = "brk_live_testkeyfortestsonly0000";

function headers(map: Record<string, string> = {}) {
  const lower = Object.fromEntries(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name: string) => lower[name.toLowerCase()] ?? null };
}

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
    // The real predicate, restated: the tools must classify BilledJobError
    // BEFORE this matches "did not complete within".
    isTimeoutError: (err: unknown) => {
      const name = err instanceof Error ? err.name : "";
      if (name === "AbortError" || name === "TimeoutError") return true;
      const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
      return msg.includes("abort") || msg.includes("timeout") || msg.includes("timed out") || msg.includes("did not complete within");
    },
  },
});
mock.module("../src/utils/wallet.js", {
  namedExports: {
    getApiBase: () => "https://api.blockrun.ai",
    resolveGatewayUrl: (u: string) => (u.startsWith("http") ? u : `https://api.blockrun.ai${u.startsWith("/api/") ? u.slice(4) : u}`),
    getChain: () => "solana", // the account rail must win over the chain
    getOrCreateWalletKey: () => { throw new Error("account rail must not touch a wallet key"); },
    getWalletInfo: async () => ({ address: "0xTEST" }),
    resolveSolanaKey: () => undefined,
  },
});
mock.module("../src/utils/ssrf.js", {
  namedExports: { isBlockedFetchHostResolved: async () => false, isBlockedFetchHost: () => false },
});
mock.module("@blockrun/llm", {
  namedExports: {
    createPaymentPayload: async () => { throw new Error("account rail must not sign a payment"); },
    parsePaymentRequired: () => ({}),
    extractPaymentDetails: () => ({}),
  },
});

const { registerVideoTool } = await import("../src/tools/video.js");
const { registerMusicTool } = await import("../src/tools/music.js");
const { withTxFee } = await import("../src/utils/tx-fee.js");
const MUSIC_COST = withTxFee(0.1575);

// A movable clock: jumping it past the poll deadline inside the submit response
// skips the while-loop entirely, so the deadline path runs with no 5s sleep.
const realNow = Date.now;
let clockOffset = 0;
mock.method(Date, "now", () => realNow() + clockOffset);

function makeHarness(register: (server: any, budget: BudgetState) => void) {
  let handler: ((args: Record<string, unknown>) => Promise<any>) | undefined;
  const server = {
    registerTool: (_n: string, _c: unknown, h: any) => { handler = h; },
    server: { getClientCapabilities: () => ({}) },
  } as any;
  const budget: BudgetState = { limit: null, spent: 0, calls: 0, agents: new Map() };
  register(server, budget);
  return { call: (args: Record<string, unknown>) => handler!(args), budget };
}
const text = (res: any) => res.content.map((c: any) => c.text).join("\n");

const submit202 = (cost: string | null, pollUrl: string, jump: boolean) => () => {
  if (jump) clockOffset += 3_600_000;
  return {
    status: 202, ok: true,
    headers: headers(cost === null ? {} : { "x-blockrun-cost-usd": cost }),
    json: async () => ({ id: "job_1", poll_url: pollUrl, status: "queued" }),
  };
};
const abortError = () => { const e = new Error("This operation was aborted"); e.name = "AbortError"; return e; };

beforeEach(() => { script = []; fetchCalls = 0; clockOffset = 0; });
afterEach(() => { assert.equal(script.length, 0, "unconsumed scripted responses"); });

// ---------------------------------------------------------------------------
// video
// ---------------------------------------------------------------------------

test("video: a job that times out after submit is BOOKED at the settled cost and never told to retry", async () => {
  script = [submit202("9.450000", "/api/v1/videos/generations/job_1", true)];
  const { call, budget } = makeHarness(registerVideoTool);
  const res = await call({ prompt: "a cube", model: "bytedance/seedance-2.5", duration_seconds: 30 });
  const t = text(res);
  assert.equal(res.isError, true, t);
  assert.match(t, /billed to the BlockRun account/);
  assert.match(t, /job_1/);
  assert.match(t, /dashboard\/activity/);
  assert.match(t, /bills a second job/);
  assert.doesNotMatch(t, /please try again/);
  assert.doesNotMatch(t, /try again/i);
  assert.ok(Math.abs(budget.spent - 9.45) < 1e-9, `ledger must carry the submit charge: spent=${budget.spent}`);
  assert.equal(fetchCalls, 1);
});

test("video: a submit that gets no answer books the estimate and says the job MAY have been billed", async () => {
  script = [() => { throw abortError(); }];
  const { call, budget } = makeHarness(registerVideoTool);
  const res = await call({ prompt: "a cube", model: "xai/grok-imagine-video" });
  const t = text(res);
  assert.equal(res.isError, true, t);
  assert.match(t, /MAY have been accepted and billed/);
  assert.match(t, /dashboard\/activity/);
  assert.doesNotMatch(t, /try again/i);
  assert.doesNotMatch(t, /No payment was taken|not charged|nothing was charged/i, "a lost submit is not a known refund");
  // Conservative: the estimate is booked so the cap cannot under-count a real charge.
  assert.ok(budget.spent > 0.39 && budget.spent < 0.41, `estimate booked: spent=${budget.spent}`);
});

test("video: the happy path books the settled submit cost once", async () => {
  script = [
    submit202("0.401000", "/api/v1/videos/generations/job_1", false),
    () => ({ status: 200, ok: true, headers: headers(), json: async () => ({ status: "completed", data: [{ url: "https://blockrun.ai/media/job_1.mp4", duration_seconds: 8 }] }) }),
  ];
  const { call, budget } = makeHarness(registerVideoTool);
  const res = await call({ prompt: "a cube", model: "xai/grok-imagine-video" });
  assert.notEqual(res.isError, true, text(res));
  assert.equal(res.structuredContent.cost_usd, 0.401);
  assert.ok(Math.abs(budget.spent - 0.401) < 1e-9, `booked once: spent=${budget.spent}`);
});

// ---------------------------------------------------------------------------
// music
// ---------------------------------------------------------------------------

test("music: a job that times out after submit books the estimate when no cost header came back", async () => {
  script = [submit202(null, "/api/v1/audio/generations/job_1", true)];
  const { call, budget } = makeHarness(registerMusicTool);
  const res = await call({ prompt: "lofi beat" });
  const t = text(res);
  assert.equal(res.isError, true, t);
  assert.match(t, /billed to the BlockRun account/);
  assert.match(t, /job_1/);
  assert.match(t, /dashboard\/activity/);
  assert.doesNotMatch(t, /try again/i);
  assert.doesNotMatch(t, /peak load/);
  assert.ok(Math.abs(budget.spent - MUSIC_COST) < 1e-9, `estimate booked for a billed job: spent=${budget.spent}`);
});

test("music: a job that times out after submit books the settled cost when the header is present", async () => {
  script = [submit202("0.157500", "/api/v1/audio/generations/job_1", true)];
  const { call, budget } = makeHarness(registerMusicTool);
  const res = await call({ prompt: "lofi beat" });
  assert.equal(res.isError, true, text(res));
  assert.ok(Math.abs(budget.spent - 0.1575) < 1e-9, `settled cost booked: spent=${budget.spent}`);
});

test("music: a submit that gets no answer books the estimate and says the job MAY have been billed", async () => {
  script = [() => { throw abortError(); }];
  const { call, budget } = makeHarness(registerMusicTool);
  const res = await call({ prompt: "lofi beat" });
  const t = text(res);
  assert.equal(res.isError, true, t);
  assert.match(t, /MAY have been accepted and billed/);
  assert.doesNotMatch(t, /try again/i);
  assert.doesNotMatch(t, /peak load/);
  assert.ok(Math.abs(budget.spent - MUSIC_COST) < 1e-9, `estimate booked: spent=${budget.spent}`);
});
