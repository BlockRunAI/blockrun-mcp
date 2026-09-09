// Run with: npm test  (tsx --experimental-test-module-mocks --test)
// Drives the real blockrun_music handler with the HTTP layer and x402 payment
// helpers mocked — no network, no spend. Uses the inline 200 fast path so there
// is no polling delay. Asserts the track output carries the settled Cost line.
// node --test isolates each file in its own process, so these mocks don't leak.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import type { BudgetState } from "../src/types.js";

const TEST_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

function headers(map: Record<string, string>) {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) lower[k.toLowerCase()] = v;
  return { get: (name: string) => lower[name.toLowerCase()] ?? null };
}

// Default fetchWithTimeout sequence: 1) POST → 402, 2) POST(pay) → 200 inline
// track. A test that sets `script` takes over: each call shifts one response,
// and an empty script means the test expected NO further network call.
let fetchCall = 0;
let script: Array<() => unknown> | null = null;
const resp402 = () => ({ status: 402, ok: false, headers: headers({ "payment-required": "x402 base ..." }), json: async () => ({}) });
const fakeFetch = async () => {
  if (script) {
    const next = script.shift();
    if (!next) throw new Error("UNEXPECTED_NETWORK_CALL");
    return next();
  }
  fetchCall++;
  if (fetchCall === 1) return resp402();
  return {
    status: 200, ok: true,
    headers: headers({ "X-Payment-Receipt": "0xmusictxhash" }),
    json: async () => ({ model: "minimax/music-1.5", data: [{ url: "https://blockrun.ai/media/track_1.mp3", duration_seconds: 183 }] }),
  };
};

mock.module("../src/utils/http.js", {
  namedExports: {
    fetchWithTimeout: fakeFetch,
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
// A movable clock: jumping it past the poll deadline from inside a scripted
// poll ends the loop on the next check without four minutes of real time.
const realNow = Date.now;
let clockOffset = 0;
mock.method(Date, "now", () => realNow() + clockOffset);
mock.module("../src/utils/wallet.js", {
  namedExports: { getChain: () => "base", getOrCreateWalletKey: () => TEST_KEY, getWalletInfo: async () => ({ address: "0xTEST" }), getApiBase: () => "https://blockrun.ai/api", resolveGatewayUrl: (u: string) => (u.startsWith("http") ? u : `https://blockrun.ai/api${u.startsWith("/api/") ? u.slice(4) : u}`), },
});
mock.module("@blockrun/llm", {
  namedExports: {
    createPaymentPayload: async () => "0xpaymentpayloadmock",
    parsePaymentRequired: () => ({}),
    // 200000 micro-USDC = $0.20 — deliberately != the flat MUSIC_COST ($0.1575),
    // proving the footer reports the real 402 quote, not the estimate constant.
    extractPaymentDetails: () => ({
      amount: "200000",
      recipient: "0x0000000000000000000000000000000000000001",
      network: "eip155:8453",
      resource: { url: "https://blockrun.ai/api/v1/audio/generations", description: "BlockRun Music Generation" },
      maxTimeoutSeconds: 300,
      extra: {},
    }),
  },
});

const {
  registerMusicTool,
  MUSIC_POLL_BUDGET_MS,
  MUSIC_POLL_TIMEOUT_MS,
  MUSIC_PAYMENT_AUTH_SECONDS,
  MUSIC_AUTH_MARGIN_MS,
} = await import("../src/tools/music.js");
const { pollDeadline, pollTimeoutFor } = await import("../src/utils/poll.js");

function makeHarness() {
  let handler: ((args: Record<string, unknown>) => Promise<any>) | undefined;
  const server = {
    registerTool: (_n: string, _c: unknown, h: any) => { handler = h; },
    server: { getClientCapabilities: () => ({}) },
  } as any;
  const budget: BudgetState = { limit: null, spent: 0, calls: 0, agents: new Map() };
  registerMusicTool(server, budget);
  return { call: (args: Record<string, unknown>) => handler!(args), budget };
}

test("music output reports the settled Cost from the 402 quote", async () => {
  const { call, budget } = makeHarness();
  const res = await call({ prompt: "lofi beat", model: "minimax/music-1.5" });
  const text = res.content.map((c: any) => c.text).join("\n");

  assert.match(text, /Cost: \$0\.2000/);
  assert.equal(res.structuredContent.cost_usd, 0.2);
  assert.ok(Math.abs(budget.spent - 0.2) < 1e-9, `budget.spent ${budget.spent} ≈ 0.2`);
});

// The poll budget is measured from AFTER submit, but validBefore is counted
// from signing — so the two deadlines are not interchangeable and the loop has
// to respect both. Submit is allowed up to 95s (music.ts), which is exactly the
// term a naive "budget < auth" check forgets.
test("the music poll window cannot outlive the payment authorization, even after a slow submit", () => {
  const SUBMIT_TIMEOUT_MS = 95_000;
  const authMs = MUSIC_PAYMENT_AUTH_SECONDS * 1000;

  // Worst case measured from signing, which is the only origin validBefore
  // knows about: submit + the full poll budget + one clamped poll.
  const worstCaseFromSigning = SUBMIT_TIMEOUT_MS + MUSIC_POLL_BUDGET_MS + MUSIC_POLL_TIMEOUT_MS;

  // Today the poll budget is the binding deadline and this holds outright.
  assert.ok(
    worstCaseFromSigning < authMs,
    `worst case ${worstCaseFromSigning}ms must stay inside the ${authMs}ms authorization`,
  );

  // The assertion that actually earns its keep: the auth-derived deadline must
  // BIND once the budget grows past what the authorization can cover. Asserted
  // against pollDeadline() itself rather than by restating the arithmetic here,
  // so it fails if the loop stops consulting the authorization at all.
  const signedAt = 1_000_000;
  const startedAt = signedAt + SUBMIT_TIMEOUT_MS; // worst-case slow submit
  const authCap = signedAt + authMs - MUSIC_AUTH_MARGIN_MS;

  // Today: the budget is the binding clock, so the full window survives.
  assert.equal(
    pollDeadline(startedAt, MUSIC_POLL_BUDGET_MS, signedAt, authMs, MUSIC_AUTH_MARGIN_MS),
    startedAt + MUSIC_POLL_BUDGET_MS,
    "at today's constants the poll budget should bind, leaving the window intact",
  );

  // The crossover: the budget stops binding once startedAt + budget passes the
  // authorization cap, i.e. above authMs - margin - submit = 445s here. Below
  // it the budget still rules; above it the authorization takes over instead of
  // the loop running past validBefore.
  assert.equal(
    pollDeadline(startedAt, 445_000, signedAt, authMs, MUSIC_AUTH_MARGIN_MS),
    startedAt + 445_000,
    "445s is the last budget the authorization can still cover",
  );
  for (const inflated of [446_000, 540_000, 900_000]) {
    const d = pollDeadline(startedAt, inflated, signedAt, authMs, MUSIC_AUTH_MARGIN_MS);
    assert.equal(d, authCap, `budget ${inflated}ms must be capped by the authorization`);
    // The real invariant. No poll can outlive `d` — pollTimeoutFor clamps the
    // last one to whatever is left and returns 0 at the deadline itself — so
    // what has to hold is that `d` stops short of validBefore by the full
    // margin, leaving the gateway room to settle the poll it just answered.
    assert.ok(
      d + MUSIC_AUTH_MARGIN_MS <= signedAt + authMs,
      "the loop must stop at least one margin before validBefore",
    );
    assert.equal(
      pollTimeoutFor(d, d, MUSIC_POLL_TIMEOUT_MS),
      0,
      "a poll attempted at the deadline must be refused, not issued",
    );
  }
});

// ---------------------------------------------------------------------------
// The Base async path: the same money-path holes video.ts closed in 0.39.1,
// which music never received (PR #101 touched video only).
// ---------------------------------------------------------------------------

const respSubmit202 = () => ({ status: 202, ok: true, headers: headers({}), json: async () => ({ id: "trk_1", poll_url: "/api/v1/audio/generations/trk_1", status: "queued" }) });
const respPoll = (http: number, body: unknown) => ({ status: http, ok: http >= 200 && http < 300, headers: headers({}), json: async () => body });
const abortError = () => { const e = new Error("This operation was aborted"); e.name = "AbortError"; return e; };
const text = (res: any) => res.content.map((c: any) => c.text).join("\n");

test("a malformed completed poll still BOOKS the settled spend (the money already moved)", async () => {
  // Settlement happens on the first completed poll. The old path threw on the
  // missing URL first, the catch returned an error, and finally released the
  // reservation: $0.20 gone on-chain, $0 in the ledger.
  script = [resp402, respSubmit202, () => respPoll(200, { status: "completed", data: [] })];
  clockOffset = 0;
  const { call, budget } = makeHarness();
  const res = await call({ prompt: "lofi beat" });
  assert.equal(res.isError, true, "a payload with no track URL is still an error for the caller");
  assert.match(text(res), /missing track URL/);
  assert.ok(Math.abs(budget.spent - 0.2) < 1e-9, `settled charge must stay booked: spent=${budget.spent}`);
  script = null;
});

test("an inline 200 with no receipt header and no track URL still books — a 200 on this route IS a settlement", async () => {
  script = [resp402, () => respPoll(200, {})];
  const { call, budget } = makeHarness();
  const res = await call({ prompt: "lofi beat" });
  assert.equal(res.isError, true);
  assert.match(text(res), /No track URL/);
  assert.ok(Math.abs(budget.spent - 0.2) < 1e-9, `settled charge must stay booked: spent=${budget.spent}`);
  script = null;
});

test("the happy async path books the settled amount exactly once", async () => {
  script = [resp402, respSubmit202, () => respPoll(200, { status: "completed", data: [{ url: "https://blockrun.ai/media/trk_1.mp3", duration_seconds: 180 }] })];
  const { call, budget } = makeHarness();
  const res = await call({ prompt: "lofi beat" });
  assert.notEqual(res.isError, true, text(res));
  assert.ok(Math.abs(budget.spent - 0.2) < 1e-9, `booked once, not twice: spent=${budget.spent}`);
  script = null;
});

test("a transient poll rejection is retried inside the deadline, not fatal", async () => {
  script = [resp402, respSubmit202, () => { throw new TypeError("fetch failed"); }, () => respPoll(200, { status: "completed", data: [{ url: "https://blockrun.ai/media/trk_1.mp3" }] })];
  const { call, budget } = makeHarness();
  const res = await call({ prompt: "lofi beat" });
  assert.notEqual(res.isError, true, text(res));
  assert.ok(Math.abs(budget.spent - 0.2) < 1e-9, `booked once: spent=${budget.spent}`);
  script = null;
});

test("a paid poll still in flight at the deadline MAY have settled: say so, book conservatively, no 'try again'", async () => {
  script = [resp402, respSubmit202, () => { clockOffset += 3_600_000; throw abortError(); }];
  const { call, budget } = makeHarness();
  const res = await call({ prompt: "lofi beat" });
  const t = text(res);
  assert.equal(res.isError, true, t);
  assert.match(t, /MAY have settled/);
  assert.match(t, /blockrun_wallet action:"report"/);
  assert.match(t, /claimable.*job trk_1/);
  assert.doesNotMatch(t, /please try again|peak load/);
  assert.doesNotMatch(t, /No payment was taken/, "a possible settlement is not a known refund");
  assert.ok(Math.abs(budget.spent - 0.2) < 1e-9, `booked conservatively: spent=${budget.spent}`);
  script = null; clockOffset = 0;
});

test("the deadline with the last poll answered: no charge, the job id, and no 'try again'", async () => {
  script = [resp402, respSubmit202, () => { clockOffset += 3_600_000; return respPoll(202, { status: "in_progress" }); }];
  const { call, budget } = makeHarness();
  const res = await call({ prompt: "lofi beat" });
  const t = text(res);
  assert.equal(res.isError, true, t);
  assert.match(t, /did not complete within 240s \(last status: in_progress\)/);
  assert.match(t, /No payment was taken/);
  assert.match(t, /claimable.*job trk_1/);
  assert.doesNotMatch(t, /please try again|peak load/);
  assert.equal(budget.spent, 0, "an answered poll that did not complete settles nothing");
  script = null; clockOffset = 0;
});

test("a paid submit that aborts MAY have settled inline: say so and book conservatively", async () => {
  // Fast tracks settle inline on the submit itself (200), so a submit that
  // leaves with the payment header and never answers is not "no charge".
  script = [resp402, () => { throw abortError(); }];
  const { call, budget } = makeHarness();
  const res = await call({ prompt: "lofi beat" });
  const t = text(res);
  assert.equal(res.isError, true, t);
  assert.match(t, /MAY have settled/);
  assert.doesNotMatch(t, /please try again|peak load/);
  assert.doesNotMatch(t, /No payment was taken/);
  assert.ok(Math.abs(budget.spent - 0.2) < 1e-9, `booked conservatively: spent=${budget.spent}`);
  script = null;
});
