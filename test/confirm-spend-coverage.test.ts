// Run with: npm test  (tsx --experimental-test-module-mocks --test)
//
// confirmSpend (src/utils/confirm-spend.ts) is the human-in-the-loop gate: with
// BLOCKRUN_CONFIRM_SPEND=on the server asks the user, via MCP elicitation, before
// it signs a paid x402 call. From 0.25.0 to 0.42.0 exactly ONE tool called it —
// blockrun_image — while thirteen other paid tools reserved budget and charged
// without asking. Nothing failed, because nothing looked; the README could only
// have described a feature 1 of 15 paid tools delivered.
//
// Two guards, because the failure mode is silence in both directions:
//
//  1. STATIC — every src/tools/*.ts that reserves budget must also call
//     confirmSpend. A new paid tool that copies the reserve/record shape but
//     forgets the confirm would otherwise ship un-gated forever.
//  2. BEHAVIORAL — with confirmation on and a client that answers "decline",
//     every paid tool must return a non-error "declined" result, release its
//     reservation (budget.spent back to 0), and never reach the network.
//
// Sibling: confirm-spend.test.ts proves the gate's own semantics (threshold,
// fail-open, session latch). This file proves every paid tool actually USES it.
process.env.BLOCKRUN_CONFIRM_SPEND = "on";
process.env.BLOCKRUN_CONFIRM_THRESHOLD = "0";

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { BudgetState } from "../src/types.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOOLS_DIR = join(ROOT, "src", "tools");

// ---------------------------------------------------------------------------
// 1. Static guard
// ---------------------------------------------------------------------------
test("every tool that reserves budget also asks the user (confirmSpend)", () => {
  const offenders: string[] = [];
  for (const file of readdirSync(TOOLS_DIR).filter((f) => f.endsWith(".ts"))) {
    const src = readFileSync(join(TOOLS_DIR, file), "utf8");
    const reserves = (src.match(/reserveBudget\(budget/g) ?? []).length;
    if (reserves === 0) continue;
    const imports = /from "\.\.\/utils\/confirm-spend\.js"/.test(src);
    const calls = (src.match(/confirmSpend\(server/g) ?? []).length;
    if (!imports || calls === 0) offenders.push(`${file} (reserves=${reserves}, confirms=${calls})`);
  }
  assert.deepEqual(
    offenders,
    [],
    `paid tools that charge without confirmSpend — they bypass BLOCKRUN_CONFIRM_SPEND:\n  ${offenders.join("\n  ")}`,
  );
});

// ---------------------------------------------------------------------------
// 2. Behavioral guard
// ---------------------------------------------------------------------------
const TEST_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
let networkCalls = 0;
const boom = () => { networkCalls++; throw new Error("UNEXPECTED_NETWORK_CALL"); };
// Any method on any client is a network call.
const trap = new Proxy({}, { get: () => boom });

mock.module("../src/utils/wallet.js", {
  namedExports: {
    getChain: () => "base",
    getClient: () => trap,
    buildClient: () => trap,
    buildClientWithTimeout: () => trap,
    getPriceClient: () => trap,
    getAnthropicClient: () => trap,
    baseOnlyMessage: () => null,
    getOrCreateWalletKey: () => TEST_KEY,
    getWalletInfo: async () => ({ address: "0xTEST" }),
  },
});
mock.module("../src/utils/http.js", {
  namedExports: { fetchWithTimeout: async () => boom(), isTimeoutError: () => false },
});
mock.module("../src/utils/ssrf.js", {
  namedExports: { isBlockedFetchHostResolved: async () => false, isBlockedFetchHost: () => false },
});

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;

function harness(register: (server: unknown, budget: BudgetState) => void) {
  let handler: Handler | undefined;
  const server = {
    registerTool: (_n: string, _c: unknown, h: Handler) => { handler = h; },
    server: {
      getClientCapabilities: () => ({ elicitation: {} }),
      elicitInput: async () => ({ action: "decline" }),
    },
  };
  const budget: BudgetState = { limit: null, spent: 0, calls: 0, agents: new Map() };
  register(server, budget);
  assert.ok(handler, "tool did not register a handler");
  return { call: (args: Record<string, unknown>) => handler!(args), budget };
}

// One valid PAID request per tool — each must clear its own pre-gate
// validation (chain, path, schema) so the only thing standing between it and
// the network is the confirm dialog.
const CASES: Array<{ tool: string; mod: string; register: string; args: Record<string, unknown> }> = [
  { tool: "blockrun_defi", mod: "defi", register: "registerDefiTool", args: { path: "protocols" } },
  { tool: "blockrun_markets", mod: "markets", register: "registerMarketsTool", args: { path: "markets", params: { q: "fed" } } },
  { tool: "blockrun_chat", mod: "chat", register: "registerChatTool", args: { message: "hi", model: "openai/gpt-5.6-terra" } },
  { tool: "blockrun_exa", mod: "exa", register: "registerExaTool", args: { path: "search", body: { query: "rag papers" } } },
  { tool: "blockrun_phone", mod: "phone", register: "registerPhoneTool", args: { path: "phone/lookup", body: { phone: "+14155550100" } } },
  { tool: "blockrun_modal", mod: "modal", register: "registerModalTool", args: { path: "sandbox/create", body: {} } },
  { tool: "blockrun_rpc", mod: "rpc", register: "registerRpcTool", args: { network: "ethereum", method: "eth_blockNumber" } },
  { tool: "blockrun_price", mod: "price", register: "registerPriceTool", args: { action: "price", category: "stocks", symbol: "AAPL", market: "US" } },
  { tool: "blockrun_surf", mod: "surf", register: "registerSurfTool", args: { path: "market/price", params: { symbol: "ETH" } } },
  { tool: "blockrun_search", mod: "search", register: "registerSearchTool", args: { body: { query: "fed decision" } } },
  { tool: "blockrun_music", mod: "music", register: "registerMusicTool", args: { prompt: "lofi", instrumental: true, model: "minimax/music-2.5+" } },
  { tool: "blockrun_speech", mod: "speech", register: "registerSpeechTool", args: { action: "speak", input: "hello", model: "elevenlabs/flash-v2.5", response_format: "mp3" } },
  { tool: "blockrun_realface", mod: "realface", register: "registerRealfaceTool", args: { action: "portrait", name: "Ada", image_url: "https://example.com/ada.png" } },
  { tool: "blockrun_video", mod: "video", register: "registerVideoTool", args: { prompt: "a cube", model: "bytedance/seedance-2.0" } },
];

for (const c of CASES) {
  test(`${c.tool}: a declined confirmation charges nothing, releases the reservation, and never touches the network`, async () => {
    const mod = (await import(`../src/tools/${c.mod}.js`)) as Record<string, (s: unknown, b: BudgetState) => void>;
    networkCalls = 0;
    const { call, budget } = harness(mod[c.register]);
    const res = await call(c.args);
    const text = res.content.map((p) => p.text ?? "").join("\n");
    assert.notEqual(res.isError, true, `${c.tool} returned an error instead of a decline: ${text}`);
    assert.match(text, /declined/i, `${c.tool} did not report the decline: ${text}`);
    assert.equal(networkCalls, 0, `${c.tool} reached the network after a decline`);
    assert.equal(budget.spent, 0, `${c.tool} left a reservation behind after a decline`);
  });
}
