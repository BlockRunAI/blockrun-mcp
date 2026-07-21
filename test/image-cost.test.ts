// Run with: npm test  (tsx --test)
// Verifies the Cost footer added to blockrun_image, without any real spend:
// the paid ImageClient and the chain selector are mocked, then the registered
// handler is invoked and its text/structured output is asserted.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import type { BudgetState } from "../src/types.js";

// Mock the wallet module BEFORE importing the tool: force Base chain and hand
// back a fake ImageClient whose generate/edit resolve to a hosted URL (no
// network, no payment).
const fakeImageClient = {
  generate: async () => ({ data: [{ url: "https://blockrun.ai/media/fake.png" }] }),
  edit: async () => ({ data: [{ url: "https://blockrun.ai/media/fake-edit.png" }] }),
};
mock.module("../src/utils/wallet.js", {
  namedExports: {
    getChain: () => "base",
    getImageClient: () => fakeImageClient,
    getOrCreateWalletKey: () => "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    getWalletInfo: async () => ({ address: "0xTEST" }),
  },
});

const { registerImageTool, estimateCost } = await import("../src/tools/image.js");

// Minimal McpServer stub: capture the handler registerImageTool installs.
function makeHarness() {
  let handler: ((args: Record<string, unknown>) => Promise<any>) | undefined;
  const server = {
    registerTool: (_name: string, _cfg: unknown, h: any) => { handler = h; },
    server: { getClientCapabilities: () => ({}) },
  } as any;
  const budget: BudgetState = { limit: null, spent: 0, calls: 0, agents: new Map() };
  registerImageTool(server, budget);
  return { call: (args: Record<string, unknown>) => handler!(args), budget };
}

// The Cost footer and the ledger must report what the user is CHARGED, not the
// catalog base. The gateway settles catalog x 1.05 + $0.002 (verified live:
// cogview-4 base $0.015 -> charged $0.017751), so reporting the catalog figure
// understated real spend in the footer, the confirmSpend prompt and the ledger.
test("generate result includes a Cost line at the CHARGED price, not the catalog base", async () => {
  const { call } = makeHarness();
  const res = await call({ prompt: "a red cube", model: "openai/gpt-image-2", size: "1024x1024" });
  const text = res.content.map((c: any) => c.text).join("\n");
  assert.match(text, /Cost: \$0\.0650/); // 0.06 catalog x 1.05 + $0.002
  assert.equal(res.structuredContent.cost_usd, 0.065);
  assert.equal(res.isError, undefined);
});

test("large gpt-image-2 render is billed at the large-size CHARGED price", async () => {
  const { call } = makeHarness();
  const res = await call({ prompt: "wide banner", model: "openai/gpt-image-2", size: "1536x1024" });
  const text = res.content.map((c: any) => c.text).join("\n");
  assert.match(text, /Cost: \$0\.1280/);
  assert.equal(res.structuredContent.cost_usd, 0.128);
});

test("cheapest model (cogview-4) shows its own price", async () => {
  const { call } = makeHarness();
  const res = await call({ prompt: "a cat", model: "zai/cogview-4" });
  const text = res.content.map((c: any) => c.text).join("\n");
  assert.match(text, /Cost: \$0\.0178/);
});

test("budget records the same amount that is reported to the user", async () => {
  const { call, budget } = makeHarness();
  await call({ prompt: "a dog", model: "google/nano-banana" });
  // The CHARGED price, not the $0.05 catalog base: 0.05 * 1.05 + $0.002, ceiled to
  // micro-USDC exactly as the gateway does. Footer and ledger must agree on it —
  // that is what this test is for.
  assert.equal(budget.spent, 0.054501);
});

// The large-size tier was a single >1024 rule for every model, which is wrong for
// nano-banana-pro: probed live, it charges $0.107001 at BOTH 1024x1024 and
// 2048x2048 and only steps to $0.159500 at 4096x4096. A 2048 render therefore
// reserved AND booked the 4096 price (49% over), and on the Base path the
// estimate is written to the ledger verbatim as settled spend.
test("nano-banana-pro stays on the base price through 2048 and steps only at 4096", () => {
  const base = estimateCost("google/nano-banana-pro", "1024x1024");
  assert.equal(estimateCost("google/nano-banana-pro", "2048x2048"), base, "2048 must not be billed at the 4096 tier");
  assert.ok(estimateCost("google/nano-banana-pro", "4096x4096") > base, "4096 must step up");
  assert.equal(estimateCost("google/nano-banana-pro", "4096x4096"), 0.1595); // live quote
  assert.equal(base, 0.107001);                                             // live quote
});

test("gpt-image-2 still steps above 1024", () => {
  const base = estimateCost("openai/gpt-image-2", "1024x1024");
  assert.ok(estimateCost("openai/gpt-image-2", "1536x1024") > base);
  assert.equal(base, 0.065);
});

test("a smaller-than-base render is never billed at the large tier", () => {
  assert.equal(estimateCost("google/nano-banana-pro", "512x512"), estimateCost("google/nano-banana-pro", "1024x1024"));
});
