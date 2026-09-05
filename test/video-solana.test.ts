// Run with: npm test  (tsx --experimental-test-module-mocks --test)
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { BudgetState } from "../src/types.js";

let solanaCalls = 0;
let quoteUsd = 0.5;
let completedHasUrl = true;
beforeEach(() => { solanaCalls = 0; quoteUsd = 0.5; completedHasUrl = true; });

mock.module("../src/utils/wallet.js", {
  namedExports: {
    getApiBase: () => "https://blockrun.ai/api",
    resolveGatewayUrl: (u: string) => (u.startsWith("http") ? u : `https://blockrun.ai/api${u.startsWith("/api/") ? u.slice(4) : u}`),

    getChain: () => "solana",
    getOrCreateWalletKey: () => { throw new Error("Base wallet must not be touched on the Solana route"); },
    getWalletInfo: async () => ({ address: "So1anaTest" }),
  },
});
mock.module("../src/utils/solana-402.js", {
  namedExports: {
    solanaPaidAsyncPost: async (_endpoint: string, _body: unknown, opts: { onQuote?: (usd: number) => void }) => {
      solanaCalls++;
      opts.onQuote?.(quoteUsd);
      return {
        paidUsd: quoteUsd,
        txHash: "solana-tx",
        data: {
          model: "bytedance/seedance-2.5",
          status: "completed",
          data: completedHasUrl ? [{ url: "https://blockrun.ai/media/solana.mp4", duration_seconds: 15, backed_up: true }] : [],
        },
      };
    },
  },
});
mock.module("../src/utils/http.js", {
  namedExports: { fetchWithTimeout: async () => { throw new Error("Base HTTP route reached"); }, isTimeoutError: () => false },
});
mock.module("../src/utils/ssrf.js", {
  namedExports: { isBlockedFetchHostResolved: async () => false, isBlockedFetchHost: () => false },
});
mock.module("@blockrun/llm", {
  namedExports: {
    createPaymentPayload: async () => "unused",
    parsePaymentRequired: () => ({}),
    extractPaymentDetails: () => ({}),
  },
});

const { registerVideoTool } = await import("../src/tools/video.js");

function makeHarness(limit: number | null = null) {
  let handler: ((args: Record<string, unknown>) => Promise<any>) | undefined;
  const server = { registerTool: (_n: string, _c: unknown, h: any) => { handler = h; } } as any;
  const budget: BudgetState = { limit, spent: 0, calls: 0, agents: new Map() };
  registerVideoTool(server, budget);
  return { call: (args: Record<string, unknown>) => handler!(args), budget };
}

test("Solana video uses the async SVM route and reports the settled result", async () => {
  solanaCalls = 0;
  quoteUsd = 0.5;
  completedHasUrl = true;
  const { call, budget } = makeHarness();
  const res = await call({ prompt: "a rainy alley", model: "bytedance/seedance-2.5", duration_seconds: 15 });
  assert.notEqual(res.isError, true, res.content?.[0]?.text);
  assert.equal(solanaCalls, 1);
  assert.equal(res.structuredContent.chain, "solana");
  assert.equal(res.structuredContent.url, "https://blockrun.ai/media/solana.mp4");
  assert.equal(res.structuredContent.txHash, "solana-tx");
  assert.equal(res.structuredContent.cost_usd, 0.5);
  assert.equal(budget.spent, 0.5);
});

test("Solana image-to-video forwards image_url plus aspect_ratio like Base does (the gateway quotes it)", async () => {
  const { call } = makeHarness();
  const res = await call({
    prompt: "a rainy alley",
    model: "bytedance/seedance-2.5",
    duration_seconds: 15,
    image_url: "https://example.com/keyframe.png",
    aspect_ratio: "16:9",
  });
  assert.notEqual(res.isError, true, res.content?.[0]?.text);
  assert.equal(solanaCalls, 1);
});

test("a higher Solana quote within the cap swaps the reservation without double-booking", async () => {
  quoteUsd = 5;
  const { call, budget } = makeHarness(10);
  const res = await call({ prompt: "a rainy alley", model: "bytedance/seedance-2.5", duration_seconds: 4 });
  assert.notEqual(res.isError, true, res.content?.[0]?.text);
  assert.equal(res.structuredContent.cost_usd, 5);
  assert.equal(budget.spent, 5, "reservation released, actual booked exactly once");
});

test("the authoritative Solana quote is re-checked against the budget before signing", async () => {
  solanaCalls = 0;
  quoteUsd = 5;
  const { call, budget } = makeHarness(1);
  const res = await call({ prompt: "a rainy alley", model: "bytedance/seedance-2.5", duration_seconds: 4 });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /budget|limit/i);
  assert.doesNotMatch(res.content[0].text, /needs funding/i, "a budget cap is not a funding problem");
  assert.equal(budget.spent, 0);
});

test("a malformed completed Solana payload still books the settled charge", async () => {
  quoteUsd = 0.5;
  completedHasUrl = false;
  const { call, budget } = makeHarness();
  const res = await call({ prompt: "a rainy alley", model: "bytedance/seedance-2.5", duration_seconds: 15 });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /missing video URL/);
  assert.equal(budget.spent, 0.5);
  completedHasUrl = true;
});
