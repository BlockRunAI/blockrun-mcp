// Run with: npm test  (tsx --experimental-test-module-mocks --test)
//
// 0.49.0 taught the media tools two things and taught them per-rail, which is
// how the DEFAULT chain ended up with neither:
//
//   1. A quote guard before signing (video both rails, image on Solana) — music
//      and speech kept signing whatever the 402 said.
//   2. Conservative booking when we give up while a paid request may still be
//      in flight (Base via paidPollInFlight, account rail via BilledJobError) —
//      the Solana rail booked nothing, so a settled render moved no budget at
//      all and the caller was invited to pay for it twice.
//
// Solana has been the default chain since 0.46.0.
//
// Round 3 found this file promised parity across "the media tools" and drove
// blockrun_music alone, and that its first test counted helper invocations
// rather than whether an onQuote was passed. It now runs every manual-402
// tool through the same four cases at the HELPER seam (solanaPaidPost /
// solanaPaidAsyncPost mocked); rail-parity.test.ts drives the same tools over
// a scripted wire with the real helper underneath.
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { BudgetState } from "../src/types.js";

let quoteUsd: number | null = 0.5;
let giveUp = false;
let onQuoteWasFunction: boolean | null = null;
let paidPostsIssued = 0;
let happyBody: unknown = {};
const abortError = () => { const e = new Error("This operation was aborted"); e.name = "AbortError"; return e; };

mock.module("../src/utils/wallet.js", {
  namedExports: {
    getApiBase: () => "https://sol.blockrun.ai/api",
    resolveGatewayUrl: (u: string) => u,
    getChain: () => "solana",
    getOrCreateWalletKey: () => { throw new Error("Base wallet must not be touched on the Solana rail"); },
    getImageClient: () => { throw new Error("the SDK ImageClient must not be used on the Solana rail"); },
    getWalletInfo: async () => ({ address: "So1anaTest" }),
    resolveSolanaKey: () => "solana-secret-key",
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
    getApiKey: () => undefined,
    getAuthMode: () => "wallet",
    isApiKeyMode: () => false,
    getApiKeyBase: () => "https://api.blockrun.ai",
    apiAuthHeaders: () => ({}),
    requireWalletMode: () => null,
    resetAuthCache: () => {},
  },
});
mock.module("../src/utils/solana-402.js", {
  namedExports: {
    // The async helper (video, music): hands the caller the authoritative
    // quote BEFORE signing, then either finishes or gives up on its deadline
    // with the helper's own "a poll still in flight can settle" wording.
    solanaPaidAsyncPost: async (_e: string, _b: unknown, opts: { onQuote?: (usd: number | null, d?: unknown) => void }) => {
      onQuoteWasFunction = typeof opts.onQuote === "function";
      opts.onQuote?.(quoteUsd, { resource: { description: "Seedance 2.0 Pro video generation (5s)" } });
      paidPostsIssued++;
      if (giveUp) {
        throw new Error(
          "Generation did not complete within 900s (last status: processing). No settlement receipt was " +
          "observed by this client; a poll still in flight at the deadline can settle server-side, so check the " +
          "wallet's recent transactions before retrying.",
        );
      }
      return { data: happyBody, paidUsd: quoteUsd, txHash: "sol-tx" };
    },
    // The synchronous helper (speech, image, realface): same hook, and on a
    // give-up the paid POST itself aborts after the transfer was signed. The
    // real helper fires onPaidRequest the line before the signed POST leaves
    // and onPaidResponse when any answer arrives — the seam the tools arm
    // and settle their tracker at since audit round 4 — so this stand-in
    // honours the same contract: a give-up is a request that LEFT and never
    // answered.
    solanaPaidPost: async (_e: string, _b: unknown, _t: number, opts?: { onQuote?: (usd: number | null, d?: unknown) => void; onPaidRequest?: () => void; onPaidResponse?: () => void }) => {
      onQuoteWasFunction = typeof opts?.onQuote === "function";
      opts?.onQuote?.(quoteUsd, { resource: { description: "Seedance 2.0 Pro video generation (5s)" } });
      opts?.onPaidRequest?.();
      paidPostsIssued++;
      if (giveUp) throw abortError();
      opts?.onPaidResponse?.();
      return { data: happyBody, paidUsd: quoteUsd, txHash: "sol-tx" };
    },
  },
});
mock.module("../src/utils/http.js", {
  namedExports: {
    fetchWithTimeout: async () => { throw new Error("the Base HTTP route must not be reached"); },
    isTimeoutError: (err: unknown) => {
      const name = err instanceof Error ? err.name : "";
      if (name === "AbortError" || name === "TimeoutError") return true;
      const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
      return msg.includes("abort") || msg.includes("timeout") || msg.includes("timed out") || msg.includes("did not complete within");
    },
  },
});
mock.module("../src/utils/ssrf.js", {
  namedExports: { isBlockedFetchHostResolved: async () => false, isBlockedFetchHost: () => false },
});
class FakePaymentError extends Error { constructor(m: string) { super(m); this.name = "PaymentError"; } }
mock.module("@blockrun/llm", {
  namedExports: {
    PaymentError: FakePaymentError,
    createPaymentPayload: async () => { throw new Error("nothing is signed on Base in this suite"); },
    parsePaymentRequired: () => ({}),
    extractPaymentDetails: () => ({}),
    solanaPublicKey: async () => "So1anaTest",
  },
});

const { registerVideoTool, estimateVideoCost } = await import("../src/tools/video.js");
const { registerMusicTool } = await import("../src/tools/music.js");
const { registerSpeechTool, speechCost } = await import("../src/tools/speech.js");
const { registerImageTool, estimateCost: estimateImageCost } = await import("../src/tools/image.js");
const { registerRealfaceTool } = await import("../src/tools/realface.js");
const { withTxFee } = await import("../src/utils/tx-fee.js");

type Register = (server: any, budget: BudgetState) => void;
function makeHarness(register: Register, limit: number | null = null) {
  let handler: ((a: Record<string, unknown>) => Promise<any>) | undefined;
  const server = { registerTool: (_n: string, _c: unknown, h: any) => { handler = h; }, server: { getClientCapabilities: () => ({}) } } as any;
  const budget: BudgetState = { limit, spent: 0, calls: 0, agents: new Map() };
  register(server, budget);
  return { call: (a: Record<string, unknown>) => handler!(a), budget };
}
const text = (res: any) => res.content.map((c: any) => c.text).join("\n");
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

const INPUT = "x".repeat(1000);
const TOOLS: Array<{ name: string; register: Register; args: Record<string, unknown>; estimate: number; happy: unknown }> = [
  { name: "video", register: registerVideoTool, args: { prompt: "a cube", model: "bytedance/seedance-2.0", duration_seconds: 5 }, estimate: estimateVideoCost("bytedance/seedance-2.0", 5), happy: { status: "completed", data: [{ url: "https://blockrun.ai/media/v.mp4", duration_seconds: 5 }] } },
  { name: "music", register: registerMusicTool, args: { prompt: "lofi", instrumental: true, model: "minimax/music-2.5+" }, estimate: withTxFee(0.1575), happy: { data: [{ url: "https://blockrun.ai/media/x.mp3", duration_seconds: 30 }] } },
  { name: "speech", register: registerSpeechTool, args: { action: "speak", input: INPUT, model: "elevenlabs/flash-v2.5", response_format: "mp3" }, estimate: speechCost("elevenlabs/flash-v2.5", INPUT), happy: { data: [{ url: "https://blockrun.ai/media/s.mp3", format: "mp3" }] } },
  { name: "image", register: registerImageTool, args: { prompt: "a red cube", model: "zai/cogview-4", size: "1024x1024" }, estimate: estimateImageCost("zai/cogview-4", "1024x1024"), happy: { data: [{ url: "https://blockrun.ai/media/i.png" }] } },
  { name: "realface", register: registerRealfaceTool, args: { action: "portrait", name: "Ada", image_url: "https://ok.example.com/ada.png" }, estimate: withTxFee(0.01), happy: { asset_id: "ta_abc", name: "Ada" } },
];

beforeEach(() => { quoteUsd = 0.5; giveUp = false; onQuoteWasFunction = null; paidPostsIssued = 0; happyBody = {}; });

for (const t of TOOLS) {
  test(`${t.name} on Solana hands the helper an onQuote — the guard cannot fire against nobody`, async () => {
    // Asserted on the OPTION, not on the helper being called: the first
    // version counted invocations, which removing onQuote left unchanged.
    quoteUsd = t.estimate;
    happyBody = t.happy;
    const { call } = makeHarness(t.register);
    await call(t.args);
    assert.equal(onQuoteWasFunction, true, `${t.name}: no onQuote passed to the Solana helper`);
  });

  test(`${t.name}: a Solana quote far above the published rate is refused BEFORE the transfer is signed`, async () => {
    // The exact 2026-09-08 shape: sol.blockrun.ai quoting a different product
    // at 2.7x. Refused inside onQuote, so the helper never reaches its paid POST.
    quoteUsd = Number((t.estimate * 2.7).toFixed(6));
    const { call, budget } = makeHarness(t.register);
    const res = await call(t.args);
    const txt = text(res);
    assert.equal(res.isError, true, txt);
    assert.match(txt, new RegExp(`quoted \\$${quoteUsd.toFixed(4)}`), txt);
    assert.match(txt, /Seedance 2\.0 Pro video generation/, "names what the gateway said it was quoting");
    assert.match(txt, /no charge was made/i);
    assert.doesNotMatch(txt, /needs funding|out of funds/i, "a refused quote is not a funding problem");
    assert.equal(paidPostsIssued, 0, `${t.name}: the paid POST must never be issued for a refused quote`);
    assert.equal(budget.spent, 0, "a refused quote settles nothing");
  });

  test(`${t.name}: a quote inside the tolerance still re-reserves against the cap before signing`, async () => {
    quoteUsd = Number((t.estimate * 1.25).toFixed(6)); // real markup, allowed by the guard
    const { call, budget } = makeHarness(t.register, t.estimate * 1.1); // the estimate fits; the quote does not
    const res = await call(t.args);
    const txt = text(res);
    assert.equal(res.isError, true, txt);
    assert.match(txt, /budget|limit/i, txt);
    assert.match(txt, /No charge was made/i);
    assert.equal(paidPostsIssued, 0, `${t.name}: the paid POST must not go out past the cap`);
    assert.equal(budget.spent, 0);
  });

  test(`${t.name}: giving up on Solana books the QUOTE conservatively instead of reporting a free failure`, async () => {
    quoteUsd = Number((t.estimate * 1.2).toFixed(6));
    giveUp = true;
    const { call, budget } = makeHarness(t.register);
    const res = await call(t.args);
    const txt = text(res);
    assert.equal(res.isError, true, txt);
    assert.match(txt, /MAY have gone through/, txt);
    assert.match(txt, /action:"report"/);
    assert.doesNotMatch(txt, /No payment was taken/, "Solana cannot promise that");
    assert.ok(near(budget.spent, quoteUsd), `${t.name}: the quote must be booked: spent=${budget.spent}, quote=${quoteUsd}`);
  });

  test(`${t.name}: the happy path books exactly the settled amount, once`, async () => {
    quoteUsd = Number((t.estimate * 1.02).toFixed(6));
    happyBody = t.happy;
    const { call, budget } = makeHarness(t.register);
    const res = await call(t.args);
    assert.notEqual(res.isError, true, text(res));
    assert.ok(near(budget.spent, quoteUsd), `${t.name}: spent=${budget.spent}, quote=${quoteUsd}`);
  });
}
