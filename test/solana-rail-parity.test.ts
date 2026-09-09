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
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { BudgetState } from "../src/types.js";

let quoteUsd: number | null = 0.5;
let giveUp = false;
let onQuoteSeen = 0;
mock.module("../src/utils/wallet.js", {
  namedExports: {
    getApiBase: () => "https://blockrun.ai/api",
    resolveGatewayUrl: (u: string) => u,
    getChain: () => "solana",
    getOrCreateWalletKey: () => { throw new Error("Base wallet must not be touched on the Solana rail"); },
    getWalletInfo: async () => ({ address: "So1anaTest" }),
  },
});
mock.module("../src/utils/auth.js", {
  namedExports: { isApiKeyMode: () => false, getApiKey: () => undefined, apiAuthHeaders: () => ({}), getApiKeyBase: () => "", PORTAL_CREDITS_URL: "" },
});
mock.module("../src/utils/solana-402.js", {
  namedExports: {
    solanaPaidAsyncPost: async (_e: string, _b: unknown, opts: { onQuote?: (usd: number | null, d?: unknown) => void }) => {
      onQuoteSeen++;
      // The helper hands the caller the authoritative quote BEFORE signing.
      opts.onQuote?.(quoteUsd, { resource: { description: "Seedance 2.0 Pro video generation (5s)" } });
      if (giveUp) {
        throw new Error(
          "Music generation did not complete within 900s (last status: processing). No settlement receipt was " +
          "observed by this client; a poll still in flight at the deadline can settle server-side, so check the " +
          "wallet's recent transactions before retrying.",
        );
      }
      return { data: { data: [{ url: "https://blockrun.ai/media/x.mp3", duration_seconds: 30 }] }, paidUsd: quoteUsd, txHash: "sol-tx" };
    },
    solanaPaidPost: async () => ({ data: {}, paidUsd: 0, txHash: "" }),
  },
});
mock.module("../src/utils/http.js", {
  namedExports: {
    fetchWithTimeout: async () => { throw new Error("the Base HTTP route must not be reached"); },
    isTimeoutError: (e: unknown) => e instanceof Error && /did not complete within/.test(e.message),
  },
});
mock.module("@blockrun/llm", {
  namedExports: { createPaymentPayload: async () => "unused", parsePaymentRequired: () => ({}), extractPaymentDetails: () => ({}) },
});

const { registerMusicTool } = await import("../src/tools/music.js");

function makeHarness(limit: number | null = null) {
  let handler: ((a: Record<string, unknown>) => Promise<any>) | undefined;
  const server = { registerTool: (_n: string, _c: unknown, h: any) => { handler = h; } } as any;
  const budget: BudgetState = { limit, spent: 0, calls: 0, agents: new Map() };
  registerMusicTool(server, budget);
  return { call: (a: Record<string, unknown>) => handler!(a), budget };
}
const ARGS = { prompt: "lofi", instrumental: true, model: "minimax/music-2.5+" };

beforeEach(() => { quoteUsd = 0.5; giveUp = false; onQuoteSeen = 0; });

test("music on Solana now hands the helper an onQuote — the guard fired against nobody before", async () => {
  const { call } = makeHarness();
  await call(ARGS);
  assert.equal(onQuoteSeen, 1, "the helper was called");
});

test("a Solana quote far above the published rate is refused BEFORE the transfer is signed", async () => {
  // The exact 2026-09-08 shape: sol.blockrun.ai quoting a different product.
  quoteUsd = 1.135;
  const { call, budget } = makeHarness();
  const res = await call(ARGS);
  const text = res.content.map((c: any) => c.text).join("\n");
  assert.equal(res.isError, true, text);
  assert.match(text, /quoted \$1\.1350/);
  assert.match(text, /no charge was made/i);
  assert.doesNotMatch(text, /needs funding/i, "a refused quote is not a funding problem");
  assert.equal(budget.spent, 0, "a refused quote settles nothing");
});

test("a quote inside the tolerance still re-reserves against the cap before signing", async () => {
  quoteUsd = 0.2;               // 1.25x the $0.1595 estimate: real, and allowed
  const { call, budget } = makeHarness(0.18);
  const res = await call(ARGS);
  const text = res.content.map((c: any) => c.text).join("\n");
  assert.equal(res.isError, true, text);
  assert.match(text, /budget|limit/i, text);
  assert.match(text, /No charge was made/i);
  assert.equal(budget.spent, 0);
});

test("giving up on Solana books the charge conservatively instead of reporting a free failure", async () => {
  quoteUsd = 0.2;
  giveUp = true;
  const { call, budget } = makeHarness();
  const res = await call(ARGS);
  const text = res.content.map((c: any) => c.text).join("\n");
  assert.equal(res.isError, true);
  assert.match(text, /MAY have gone through/);
  assert.match(text, /action:"report"/);
  assert.doesNotMatch(text, /No payment was taken/, "Solana cannot promise that");
  assert.ok(Math.abs(budget.spent - 0.2) < 1e-9, `the quote must be booked: spent=${budget.spent}`);
});

test("the happy path still books exactly the settled amount, once", async () => {
  quoteUsd = 0.16;
  const { call, budget } = makeHarness();
  const res = await call(ARGS);
  assert.notEqual(res.isError, true, res.content?.[0]?.text);
  assert.ok(Math.abs(budget.spent - 0.16) < 1e-9, `spent=${budget.spent}`);
});
