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
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import type { BudgetState } from "../src/types.js";

let lastPostedEndpoint: string | undefined;
let settledCost: number | null = 0.0525;

// Drive account mode through the env var rather than mocking auth.js: the mode
// is derived from BLOCKRUN_API_KEY, and replacing that module wholesale drops
// exports other modules import (onramp.ts wants PORTAL_CREDITS_URL).
process.env.BLOCKRUN_API_KEY = "brk_live_testkeyfortestsonly0000";

// The account rail helper the four hand-built tools already use. Standing in
// for it keeps this test off the network while exercising the same seam.
mock.module("../src/utils/api-key-call.js", {
  namedExports: {
    apiKeyPost: async (endpoint: string) => {
      lastPostedEndpoint = endpoint;
      return {
        data: { data: [{ url: "https://blockrun.ai/media/fake.png" }] },
        paidUsd: settledCost,
        txHash: "credit:test",
      };
    },
  },
});

mock.module("../src/utils/wallet.js", {
  namedExports: {
    getApiBase: () => "https://api.blockrun.ai",
    resolveGatewayUrl: (u: string) => (u.startsWith("http") ? u : `https://api.blockrun.ai${u}`),
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

test("account rail reports the SETTLED cost, not the estimate", async () => {
  settledCost = 0.0525;
  const { call } = makeHarness();
  const res = await call({ prompt: "a red cube", model: "google/nano-banana" });
  const text = res.content.map((c: any) => c.text).join("\n");

  // The settled figure, and NOT flagged as an estimate — calling a number that
  // reconciles exactly "estimated" invites someone to discount it.
  assert.match(text, /Cost: \$0\.0525/);
  assert.doesNotMatch(text, /estimated/);
  assert.equal(res.structuredContent.cost_usd, 0.0525);
  assert.equal(res.structuredContent.cost_is_estimate, false);
});

test("account rail does not go through the SDK or touch a wallet", async () => {
  // getImageClient and getOrCreateWalletKey both throw in this harness, so
  // reaching either fails the test rather than silently working.
  settledCost = 0.0525;
  const { call } = makeHarness();
  const res = await call({ prompt: "a red cube", model: "google/nano-banana" });
  assert.equal(res.isError, undefined);
  assert.ok(lastPostedEndpoint, "expected the account rail to POST directly");
});

test("an absent settled cost falls back to the estimate and still says so", async () => {
  // paidUsd null means the rail settled nothing at response time. It must not
  // be booked as $0.
  settledCost = null;
  const { call, budget } = makeHarness();
  const res = await call({ prompt: "a red cube", model: "google/nano-banana" });
  const text = res.content.map((c: any) => c.text).join("\n");

  assert.match(text, /estimated/);
  assert.equal(res.structuredContent.cost_is_estimate, true);
  assert.ok(res.structuredContent.cost_usd > 0, "must not book a null as $0");
  assert.ok(budget.spent > 0, "the ledger must not record zero for a billed call");
});
