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
  },
});

const { registerImageTool } = await import("../src/tools/image.js");

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

test("generate result includes a Cost line at the model's catalog price", async () => {
  const { call } = makeHarness();
  const res = await call({ prompt: "a red cube", model: "openai/gpt-image-2", size: "1024x1024" });
  const text = res.content.map((c: any) => c.text).join("\n");
  assert.match(text, /Cost: \$0\.0600/);
  assert.equal(res.structuredContent.cost_usd, 0.06);
  assert.equal(res.isError, undefined);
});

test("large gpt-image-2 render is billed at the large-size price", async () => {
  const { call } = makeHarness();
  const res = await call({ prompt: "wide banner", model: "openai/gpt-image-2", size: "1536x1024" });
  const text = res.content.map((c: any) => c.text).join("\n");
  assert.match(text, /Cost: \$0\.1200/);
  assert.equal(res.structuredContent.cost_usd, 0.12);
});

test("cheapest model (cogview-4) shows its own price", async () => {
  const { call } = makeHarness();
  const res = await call({ prompt: "a cat", model: "zai/cogview-4" });
  const text = res.content.map((c: any) => c.text).join("\n");
  assert.match(text, /Cost: \$0\.0150/);
});

test("budget records the same amount that is reported to the user", async () => {
  const { call, budget } = makeHarness();
  await call({ prompt: "a dog", model: "google/nano-banana" });
  assert.equal(budget.spent, 0.05);
});
