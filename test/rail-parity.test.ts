// Run with: npm test  (tsx --experimental-test-module-mocks --test)
//
// THE RAIL-PARITY MATRIX.
//
// Round 1 of the 0.49.0 audit was fixed by six agents working in parallel, one
// per area, and round 2's regressions had a single fingerprint: each agent
// hardened the rail it was looking at and left its siblings alone. The quote
// guard landed on video and image but not music and speech; the in-flight
// booking on Base and the account rail but not Solana, the default chain;
// music's Solana call passed no onQuote at all, so the guard hook fired against
// nobody. Every one of those was a real money path, and every one passed CI.
//
// Round 3 found the next fingerprint: the first version of this file was a
// STATIC check — "the source mentions paidRequestInFlight" — and 0.50.0
// shipped that identifier as dead code in three tools (cleared in a `.finally`
// before the catch could read it, set on one rail out of three, module-global
// in realface, armed before the unpaid probe in image). The matrix was green
// throughout, because a grep cannot tell a guard from its name.
//
// So the money cells are now BEHAVIOURAL. For every manual-402 tool and every
// rail it serves, the HTTP layer is scripted to resolve the 402 / payment step
// and then reject the request that carries the payment, and the assertions
// are on what a user would see: the ledger (budget.spent) and the sentence
// the tool returns. Identifier presence proves nothing here. A handful of
// static cells remain for the things that ARE structural — the shapes that
// can never work, and the deliberate division between the tools that see a
// quote and the seven that let the SDK own the 402.
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { BudgetState } from "../src/types.js";

const TOOLS = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "tools");
const src = (f: string) => readFileSync(join(TOOLS, f), "utf8");

/** A paid tool that performs its OWN 402 (reads the quote, signs the payment). */
const MANUAL_402 = ["video.ts", "music.ts", "speech.ts", "image.ts", "realface.ts"] as const;

/** Paid tools that hand the whole 402 to the SDK or the account helper. */
const DELEGATED_402 = ["markets.ts", "exa.ts", "defi.ts", "rpc.ts", "search.ts", "phone.ts", "modal.ts"] as const;

// ---------------------------------------------------------------------------
// Harness: one process, every rail, switched by two variables. The real
// utils/solana-402.ts and utils/api-key-call.ts run underneath — only the
// wire (fetchWithTimeout), the wallet, the auth mode and the SDK's signing
// primitives are replaced — so a "settle-then-abort" here is the same
// sequence of fetches the tool issues in production.
// ---------------------------------------------------------------------------
type Rail = "base" | "solana" | "account";
let rail: Rail = "base";
const TEST_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const SOL_PUBKEY = "So1anaPubkey1111111111111111111111111111111";

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
    // The real predicate, restated: the deadline cases depend on the
    // "did not complete within" message being classified as a timeout.
    isTimeoutError: (err: unknown) => {
      const name = err instanceof Error ? err.name : "";
      if (name === "AbortError" || name === "TimeoutError") return true;
      const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
      return msg.includes("abort") || msg.includes("timeout") || msg.includes("timed out") || msg.includes("did not complete within");
    },
  },
});
// A movable clock: the Base video/music poll loops give up on a deadline, and
// jumping the clock from inside a scripted poll ends them on the next check
// instead of after nine minutes of real time.
const realNow = Date.now;
let clockOffset = 0;
mock.method(Date, "now", () => realNow() + clockOffset);

// The Base ImageClient stand-in: the SDK owns that 402, so the only seam is
// the call itself. `imageSdk` decides whether it answers or drops.
let imageSdk: () => Promise<{ data: Array<{ url: string }> }> = async () => ({ data: [{ url: "https://blockrun.ai/media/x.png" }] });
mock.module("../src/utils/wallet.js", {
  namedExports: {
    getApiBase: () => (rail === "account" ? "https://api.blockrun.ai" : rail === "solana" ? "https://sol.blockrun.ai/api" : "https://blockrun.ai/api"),
    resolveGatewayUrl: (u: string) => (u.startsWith("http") ? u : `https://blockrun.ai/api${u.startsWith("/api/") ? u.slice(4) : u}`),
    getChain: () => (rail === "solana" ? "solana" : "base"),
    getOrCreateWalletKey: () => {
      if (rail !== "base") throw new Error(`the EVM wallet must not be touched on the ${rail} rail`);
      return TEST_KEY;
    },
    getWalletInfo: async () => ({ address: rail === "solana" ? SOL_PUBKEY : "0xTEST" }),
    getImageClient: () => {
      if (rail !== "base") throw new Error(`the SDK ImageClient must not be used on the ${rail} rail`);
      return { generate: () => imageSdk(), edit: () => imageSdk() };
    },
    resolveSolanaKey: () => (rail === "solana" ? "solana-secret-key" : undefined),
    solanaKeyUnavailableReason: () => undefined,
  },
});
mock.module("../src/utils/auth.js", {
  namedExports: {
    DEFAULT_API_KEY_BASE: "https://api.blockrun.ai",
    PORTAL_URL: "https://user.blockrun.ai",
    PORTAL_KEYS_URL: "https://user.blockrun.ai/dashboard/keys",
    PORTAL_CREDITS_URL: "https://user.blockrun.ai/dashboard/credits",
    PORTAL_ACTIVITY_URL: "https://user.blockrun.ai/dashboard/activity",
    getApiKey: () => (rail === "account" ? "brk_live_test" : undefined),
    getAuthMode: () => (rail === "account" ? "api-key" : "wallet"),
    isApiKeyMode: () => rail === "account",
    getApiKeyBase: () => "https://api.blockrun.ai",
    apiAuthHeaders: () => (rail === "account" ? { Authorization: "Bearer brk_live_test" } : {}),
    requireWalletMode: (c: string) => (rail === "account" ? `${c} needs wallet mode` : null),
    resetAuthCache: () => {},
  },
});
mock.module("../src/utils/ssrf.js", {
  namedExports: { isBlockedFetchHostResolved: async () => false, isBlockedFetchHost: () => false },
});

// The quote every 402 carries, in micro-USDC, set per tool so it sits inside
// the quote guard's tolerance — a refused quote would prove nothing about the
// in-flight booking. `paymentsSigned` is the tripwire for "nothing signed".
let quotedAmount = "0";
let paymentsSigned = 0;
class FakePaymentError extends Error { constructor(m: string) { super(m); this.name = "PaymentError"; } }
mock.module("@blockrun/llm", {
  namedExports: {
    PaymentError: FakePaymentError,
    SOLANA_NETWORK: "solana:mainnet",
    SolanaLLMClient: { SOLANA_API_URL: "https://sol.blockrun.ai/api" },
    createPaymentPayload: async () => { paymentsSigned++; return "0xpaymentpayloadmock"; },
    createSolanaPaymentPayload: async () => { paymentsSigned++; return "solana-payment-payload"; },
    solanaKeyToBytes: async () => new Uint8Array(64),
    solanaPublicKey: async () => SOL_PUBKEY,
    parsePaymentRequired: () => ({}),
    extractPaymentDetails: () => ({
      amount: quotedAmount,
      recipient: rail === "solana" ? "Recipient111111111111111111111111111111111" : "0x0000000000000000000000000000000000000001",
      network: rail === "solana" ? "solana:mainnet" : "eip155:8453",
      resource: { url: "https://blockrun.ai/api/v1/x", description: "BlockRun media" },
      maxTimeoutSeconds: 600,
      extra: rail === "solana" ? { feePayer: "FeePayer1111111111111111111111111111111111" } : {},
    }),
  },
});

const { registerVideoTool, estimateVideoCost } = await import("../src/tools/video.js");
const { registerMusicTool } = await import("../src/tools/music.js");
const { registerSpeechTool, speechCost } = await import("../src/tools/speech.js");
const { registerImageTool, estimateCost: estimateImageCost } = await import("../src/tools/image.js");
const { registerRealfaceTool } = await import("../src/tools/realface.js");
const { withTxFee } = await import("../src/utils/tx-fee.js");
const { ledgerFallback } = await import("../src/utils/raw-call.js");

type Register = (server: any, budget: BudgetState) => void;
function harness(register: Register) {
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
const abortError = () => { const e = new Error("This operation was aborted"); e.name = "AbortError"; return e; };
const resp402 = () => ({ status: 402, ok: false, headers: headers({ "payment-required": "x402 ..." }), json: async () => ({}) });
const respSubmit202 = (id: string) => () => ({ status: 202, ok: false, headers: headers(), json: async () => ({ id, poll_url: `/api/v1/poll/${id}`, status: "queued" }) });
const micro = (usd: number) => String(Math.round(usd * 1e6));
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

/**
 * One row per tool: how to register it, what to call it with, what the gate
 * reserves, and the scripted wire for "the 402 resolved and then the request
 * carrying the payment never answered" on each rail. `expect` is what the
 * ledger must show afterwards, per rail — the quote where one was captured,
 * the reserve where the rail has none.
 */
const ROWS: Array<{
  name: string;
  register: Register;
  args: Record<string, unknown>;
  reserve: number;
  /** The Base wire after the paid request has been sent and dropped. */
  base: () => Array<() => unknown>;
  /** What Base books on that give-up. */
  baseBooks: number;
  /** Text the Base give-up must carry. */
  baseSays: RegExp;
}> = [
  {
    name: "video",
    register: registerVideoTool,
    args: { prompt: "a cube", model: "bytedance/seedance-2.0", duration_seconds: 5 },
    reserve: estimateVideoCost("bytedance/seedance-2.0", 5),
    // Base video settles on a completed poll; the paid request that can be
    // outstanding is the poll. Submit answers, the poll drops, the deadline
    // passes.
    base: () => [resp402, respSubmit202("vid_1"), () => { clockOffset += 3_600_000; throw abortError(); }],
    baseBooks: estimateVideoCost("bytedance/seedance-2.0", 5),
    baseSays: /MAY have gone through/,
  },
  {
    name: "music",
    register: registerMusicTool,
    args: { prompt: "lofi beat", instrumental: true, model: "minimax/music-2.5+" },
    reserve: withTxFee(0.1575),
    // Music can settle inline on the submit itself, so a dropped submit is
    // the outstanding paid request.
    base: () => [resp402, () => { throw abortError(); }],
    baseBooks: withTxFee(0.1575),
    baseSays: /MAY have gone through/,
  },
  {
    name: "speech",
    register: registerSpeechTool,
    args: { action: "speak", input: "x".repeat(1000), model: "elevenlabs/flash-v2.5", response_format: "mp3" },
    reserve: speechCost("elevenlabs/flash-v2.5", "x".repeat(1000)),
    base: () => [resp402, () => { throw abortError(); }],
    baseBooks: speechCost("elevenlabs/flash-v2.5", "x".repeat(1000)),
    baseSays: /MAY have gone through/,
  },
  {
    name: "image",
    register: registerImageTool,
    args: { prompt: "a red cube", model: "zai/cogview-4", size: "1024x1024" },
    reserve: estimateImageCost("zai/cogview-4", "1024x1024"),
    // The SDK owns Base's 402: the only wire is the SDK call, scripted via
    // imageSdk below. No fetch is expected.
    base: () => [],
    // No quote is visible on this rail, so the give-up books what the ledger
    // would have booked on success: the observed charge, not the reserve.
    baseBooks: 0.016751,
    baseSays: /MAY have gone through/,
  },
  {
    name: "realface",
    register: registerRealfaceTool,
    args: { action: "portrait", name: "Ada", image_url: "https://ok.example.com/ada.png" },
    reserve: withTxFee(0.01),
    base: () => [resp402, () => { throw abortError(); }],
    baseBooks: withTxFee(0.01),
    baseSays: /MAY have gone through/,
  },
];

beforeEach(() => {
  script = []; fetchCalls = 0; paymentsSigned = 0; clockOffset = 0;
  imageSdk = async () => ({ data: [{ url: "https://blockrun.ai/media/x.png" }] });
});

// The sentence every give-up must carry, and the one it must not: the
// charge may stand, here is where to check, and nothing about it being free.
function assertBooked(res: any, budget: BudgetState, expectUsd: number, says: RegExp, label: string) {
  const t = text(res);
  assert.equal(res.isError, true, `${label}: ${t}`);
  assert.match(t, says, `${label}: the give-up must say the charge may stand — got: ${t}`);
  assert.match(t, /action:"report"|dashboard\/activity/, `${label}: must say where to check — got: ${t}`);
  assert.doesNotMatch(t, /No payment was taken|no charge was made/i, `${label}: a dropped paid request cannot promise that`);
  assert.ok(near(budget.spent, expectUsd), `${label}: expected the ledger to carry $${expectUsd}, got $${budget.spent}`);
}

// ---------------------------------------------------------------------------
// Cell 1: settle-then-abort on every rail books the charge and says so.
// ---------------------------------------------------------------------------
for (const row of ROWS) {
  test(`${row.name} on Base: the paid request drops after the signature went out → booked, "may have settled"`, async () => {
    rail = "base";
    quotedAmount = micro(row.reserve);
    script = row.base();
    if (row.name === "image") imageSdk = async () => { throw abortError(); };
    const { call, budget } = harness(row.register);
    const res = await call(row.args);
    assertBooked(res, budget, row.baseBooks, row.baseSays, `${row.name}/base`);
    assert.equal(script.length, 0, "every scripted response was consumed");
  });

  test(`${row.name} on Solana: the paid request drops after the SPL transfer was signed → booked, "may have settled"`, async () => {
    rail = "solana";
    // The Solana gateway prices carry a small markup: a distinct figure proves
    // the QUOTE is booked, not the reserve.
    const solQuote = row.reserve + 0.0005;
    quotedAmount = micro(solQuote);
    script = [resp402, () => { throw abortError(); }];
    const { call, budget } = harness(row.register);
    const res = await call(row.args);
    assert.equal(paymentsSigned, 1, `${row.name}/solana: exactly one transfer signed`);
    assertBooked(res, budget, solQuote, /MAY have (gone through|settled)/, `${row.name}/solana`);
    assert.equal(script.length, 0, "every scripted response was consumed");
  });

  test(`${row.name} on the account rail: the Bearer request drops → booked, "may have been billed"`, async () => {
    rail = "account";
    script = [() => { throw abortError(); }];
    const { call, budget } = harness(row.register);
    const res = await call(row.args);
    assert.equal(paymentsSigned, 0, "nothing is signed on the account rail");
    assertBooked(res, budget, row.reserve, /MAY have (gone through|settled|been accepted)/, `${row.name}/account`);
    assert.equal(script.length, 0, "every scripted response was consumed");
  });
}

// ---------------------------------------------------------------------------
// Cell 2: a timeout on the UNPAID 402 probe books nothing. Nothing was signed
// and nothing carried a payment; booking it would invent spend and a "may
// have settled" here sends the user to check a charge that cannot exist.
// ---------------------------------------------------------------------------
for (const row of ROWS) {
  // The SDK owns Base's 402 for image, and the only seam is the whole call:
  // a probe timeout inside the SDK is indistinguishable from a paid-retry
  // timeout, so that rail deliberately books (the conservative direction).
  if (row.name !== "image") {
    test(`${row.name} on Base: the unpaid 402 probe times out → nothing booked, nothing signed`, async () => {
      rail = "base";
      quotedAmount = micro(row.reserve);
      script = [() => { throw abortError(); }];
      const { call, budget } = harness(row.register);
      const res = await call(row.args);
      assert.equal(res.isError, true);
      assert.equal(paymentsSigned, 0, "nothing to sign yet");
      assert.doesNotMatch(text(res), /MAY have/, `${row.name}/base: a probe timeout is not a maybe — got: ${text(res)}`);
      assert.equal(budget.spent, 0, `${row.name}/base: probe timeout must not book — spent=${budget.spent}`);
    });
  }

  // video and music used to branch on `getChain() === "solana" &&
  // isTimeoutError` with no in-flight state at all, so they booked the
  // estimate for a probe that never produced a signature (audit round 3,
  // D20/C32). They now arm the tracker in onQuote and at the helper's
  // onPaidRequest hook, so this cell is a real assertion for every row.
  test(
    `${row.name} on Solana: the unpaid 402 probe times out → nothing booked, nothing signed`,
    async () => {
      rail = "solana";
      quotedAmount = micro(row.reserve);
      script = [() => { throw abortError(); }];
      const { call, budget } = harness(row.register);
      const res = await call(row.args);
      assert.equal(res.isError, true);
      assert.equal(paymentsSigned, 0, "the quote never arrived, so nothing was signed");
      assert.doesNotMatch(text(res), /MAY have/, `${row.name}/solana: a probe timeout is not a maybe — got: ${text(res)}`);
      assert.equal(budget.spent, 0, `${row.name}/solana: probe timeout must not book — spent=${budget.spent}`);
    },
  );
}

// ---------------------------------------------------------------------------
// Cell 3: a Solana quote far above the estimate is refused BEFORE signing, on
// every manual-402 tool — the 2026-09-08 shape (sol.blockrun.ai quoting a
// different product at 2.7x). The first matrix checked this per FILE, and
// speech's Base guard covered for a Solana hook that had none.
// ---------------------------------------------------------------------------
for (const row of ROWS) {
  test(`${row.name} on Solana: a 2.7x quote is refused unsigned — no charge, no booking`, async () => {
    rail = "solana";
    quotedAmount = micro(row.reserve * 2.7);
    script = [resp402];
    const { call, budget } = harness(row.register);
    const res = await call(row.args);
    const t = text(res);
    assert.equal(res.isError, true, `${row.name}/solana: ${t}`);
    assert.match(t, /Refusing to sign it|no charge was made/i, `${row.name}/solana: must refuse the quote — got: ${t}`);
    assert.equal(paymentsSigned, 0, `${row.name}/solana: a refused quote must not be signed`);
    assert.equal(budget.spent, 0, `${row.name}/solana: a refused quote settles nothing`);
    assert.equal(script.length, 0, "the paid POST was never issued");
  });
}

// ---------------------------------------------------------------------------
// Cell 4: the happy path books exactly the settled amount, once, on every
// rail — so the give-up bookings above cannot be "passing" by double-booking.
// ---------------------------------------------------------------------------
const HAPPY: Record<string, { body: unknown; account: unknown }> = {
  video: { body: null, account: null }, // async on every rail; covered by video-money-path / video-solana / api-key-call tests
  music: { body: { model: "minimax/music-2.5+", data: [{ url: "https://blockrun.ai/media/t.mp3", duration_seconds: 30 }] }, account: null },
  speech: { body: { model: "elevenlabs/flash-v2.5", data: [{ url: "https://blockrun.ai/media/s.mp3", format: "mp3" }] }, account: null },
  image: { body: { data: [{ url: "https://blockrun.ai/media/i.png" }] }, account: null },
  realface: { body: { asset_id: "ta_abc", name: "Ada" }, account: null },
};
for (const row of ROWS) {
  const happy = HAPPY[row.name];
  if (!happy.body) continue;
  test(`${row.name} on Solana: a settled 200 books the quote exactly once`, async () => {
    rail = "solana";
    const solQuote = row.reserve + 0.0005;
    quotedAmount = micro(solQuote);
    script = [resp402, () => ({ status: 200, ok: true, headers: headers({ "x-payment-receipt": "sol-tx" }), json: async () => happy.body })];
    const { call, budget } = harness(row.register);
    const res = await call(row.args);
    assert.notEqual(res.isError, true, text(res));
    assert.ok(near(budget.spent, solQuote), `${row.name}/solana: spent=${budget.spent}, quote=${solQuote}`);
  });
  test(`${row.name} on the account rail: a settled 200 books the cost header exactly once`, async () => {
    rail = "account";
    const settled = row.reserve - 0.001; // the account rail bills the base, no tx fee
    script = [() => ({ status: 200, ok: true, headers: headers({ "x-blockrun-cost-usd": settled.toFixed(6), "x-payment-receipt": "credit:1" }), json: async () => happy.body })];
    const { call, budget } = harness(row.register);
    const res = await call(row.args);
    assert.notEqual(res.isError, true, text(res));
    assert.ok(near(budget.spent, Number(settled.toFixed(6))), `${row.name}/account: spent=${budget.spent}, header=${settled.toFixed(6)}`);
  });
}

// ---------------------------------------------------------------------------
// Static cells. These are structural claims a grep CAN make honestly.
// ---------------------------------------------------------------------------
test("no tool clears its in-flight state in a `.finally` on the awaited paid request", () => {
  // Promise#finally runs its callback BEFORE the rejection reaches the
  // awaiting catch, so a flag cleared there is always false by the time the
  // catch reads it. 0.50.0 shipped exactly this in speech, realface and image.
  for (const f of MANUAL_402) {
    assert.doesNotMatch(src(f), /\.finally\(\(\) => \{\s*paid\w*InFlight\s*=\s*false/, `${f}: clears the in-flight flag before the catch can see it`);
    assert.doesNotMatch(src(f), /\.finally\(\(\) => \w+\.settle\(\)\)/, `${f}: settles the tracker before the catch can see it`);
  }
});

test("no tool keeps in-flight state at module scope", () => {
  // The MCP SDK dispatches tool calls concurrently; a shared flag makes one
  // call's outstanding payment book against another call's failure.
  for (const f of MANUAL_402) {
    assert.doesNotMatch(src(f), /^(let|var)\s+paid\w*InFlight\b/m, `${f}: module-global in-flight flag`);
    assert.doesNotMatch(src(f), /^(let|var|const)\s+\w+\s*=\s*trackPaidRequest\(\)/m, `${f}: module-global paid-request tracker`);
  }
});

test("every Solana onQuote hook checks WHAT was quoted, not only how much", () => {
  // The helper's onQuote is the last stop before the SPL transfer is signed.
  // Checked per HOOK, not per file: speech's Base branch had the guard and
  // its Solana hook did not, and the per-file grep could not tell.
  for (const f of MANUAL_402) {
    const s = src(f);
    const hooks = [...s.matchAll(/onQuote:\s*\([^)]*\)\s*=>\s*\{/g)];
    if (!/solanaPaid(Post|AsyncPost)\(/.test(s)) continue;
    assert.ok(hooks.length > 0, `${f}: calls the Solana helper without an onQuote guard`);
    for (const h of hooks) {
      const body = s.slice(h.index!, h.index! + 1200);
      if (/onQuote\?\.\(/.test(body)) {
        // The hook delegates to a caller-supplied callback (realface's shared
        // payAndPostJson): every such callback must carry the guard instead.
        const callers = [...s.matchAll(/payAndPostJson\(/g)].filter((m) => !/async function payAndPostJson/.test(s.slice(m.index! - 20, m.index! + 20)));
        assert.ok(callers.length > 0, `${f}: delegating onQuote hook with no callers to carry the guard`);
        for (const c of callers) {
          assert.match(s.slice(c.index!, c.index! + 1200), /assertQuoteNearEstimate\(|assertVideoQuoteSane\(/, `${f}: a payAndPostJson caller supplies an onQuote without checking what was quoted`);
        }
        continue;
      }
      assert.match(body, /assertQuoteNearEstimate\(|assertVideoQuoteSane\(/, `${f}: an onQuote hook re-reserves without checking what was quoted`);
    }
  }
});

test("no delegated-402 tool pretends to check a quote it cannot see", () => {
  // The SDK owns their 402 and does not surface the amount, so a guard there
  // would be theatre. This asserts the DIVISION is deliberate: if one of these
  // ever grows a quote check, it has moved rails and this table must say so.
  for (const f of DELEGATED_402) {
    const s = src(f);
    assert.doesNotMatch(s, /assertQuoteNearEstimate|assertVideoQuoteSane/, `${f}: grew a quote guard — update the matrix`);
    assert.doesNotMatch(s, /trackPaidRequest\(/, `${f}: grew in-flight tracking it cannot arm honestly (the SDK owns the paid request) — update the matrix`);
  }
});

test("every delegated-402 tool books the observed charge, not its reserve", () => {
  // The reserve rounds against us on purpose ($0.002 fee where the gateway
  // charges $0.001 on Base and nothing on Solana). Booking it inflates recorded
  // spend on every call and trips caps early — up to 2x on the default chain.
  for (const f of DELEGATED_402) {
    assert.match(src(f), /ledgerFallback\(/, `${f}: books its reserve as settled spend`);
  }
});

test("image's SDK-owned Base rail books the observed charge too", () => {
  // Live 402 probe of /v1/images/generations on 2026-09-13: cogview-4 quotes
  // 16750 micro ($0.01675 = base x 1.05 + $0.001) against a $0.017751
  // reserve. The reserve stays high on purpose; the LEDGER books what is
  // charged — which is what ledgerFallback reconstructs on every rail.
  rail = "base";
  assert.ok(near(ledgerFallback(0.017751), 0.016751), `ledgerFallback(0.017751)=${ledgerFallback(0.017751)}`);
  assert.match(src("image.ts"), /ledgerFallback\(/, "image.ts Base rail books the reserve");
});

test("the matrix covers every paid tool in the directory", () => {
  // The point of a table is that nothing is missing from it. A new paid tool
  // must be classified, not silently skipped.
  const classified = new Set<string>([...MANUAL_402, ...DELEGATED_402]);
  const unclassified: string[] = [];
  for (const f of readdirSync(TOOLS).filter((n) => n.endsWith(".ts"))) {
    if (classified.has(f)) continue;
    const s = src(f);
    // Free tools and the wallet/chat tools are out of scope by construction:
    // chat settles per token through the SDK and has its own settled-cost
    // wrapper; wallet, models, dex and polymarket_read take no payment here.
    if (!/reserveBudget\(budget/.test(s)) continue;
    if (["chat.ts", "chat-anthropic.ts", "polymarket.ts", "wallet.ts"].includes(f)) continue;
    // price.ts reserves but cannot currently pay: the equity route has
    // answered 501 since 2026-09-05 and the tool short-circuits BEFORE the
    // reservation (price-behaviour.test.ts pins that). The day the route
    // returns, its paid path pays through the SDK's PriceClient and books
    // the reserve — classify it as DELEGATED_402 and route it through
    // raw-call's ledgerFallback then. The assertion below ties the
    // exclusion to the reason it is safe: an SDK-direct paid call that has
    // no quote guard must not be reachable.
    if (f === "price.ts") {
      assert.match(s, /501/, "price.ts no longer mentions the 501 short-circuit — classify it in the matrix");
      assert.doesNotMatch(s, /assertQuoteNearEstimate|trackPaidRequest/, "price.ts grew paid-path treatments — classify it in the matrix");
      continue;
    }
    unclassified.push(f);
  }
  assert.deepEqual(unclassified, [], `paid tools missing from the rail-parity matrix: ${unclassified.join(", ")}`);
});
