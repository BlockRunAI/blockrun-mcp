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
//  1. STATIC — every src/tools/*.ts that can PAY must reserve budget AND call
//     confirmSpend. "Can pay" is read off the imports: a paid SDK client from
//     utils/wallet.ts, or one of the hand-built rails (raw-call, api-key-call,
//     solana-402). The guard used to key on reserveBudget alone and skip any
//     file without it — so the worst possible offender, a tool that pays and
//     never reserves, was the one it could not see. A file that reserves via
//     some helper this list does not know is still held to the confirm.
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
// The surfaces through which a tool file can move money. A file that imports
// any of these is a paid tool, whether or not it remembered to reserve.
const PAID_CLIENTS = /\b(getClient|getImageClient|buildClient|buildClientWithTimeout|getAnthropicClient|getPriceClient)\b/;
const PAID_HELPERS = /from "\.\.\/utils\/(raw-call|api-key-call|solana-402)\.js"/;

// Paid-surface importers that genuinely never charge. Each entry is a claim
// that has to be re-made when the file changes; keep it short and say why.
const FREE_BY_DESIGN: Record<string, string> = {
  // getClient() only feeds loadModels()/listModels — the free catalogue GET.
  "models.ts": "getClient feeds the free /v1/models catalogue read only",
};

/**
 * What the static guard sees in one tool file. Exported shape, so the guard's
 * own rules can be tested on fixtures below — a guard that cannot be shown to
 * bite is only a comment.
 */
function classifyToolSource(file: string, src: string): { paid: boolean; reserves: number; confirms: number; imports: boolean; offence: string | null } {
  const walletImport = /import\s*\{([^}]*)\}\s*from\s*"\.\.\/utils\/wallet\.js"/.exec(src)?.[1] ?? "";
  const paidSurface = PAID_CLIENTS.test(walletImport) || PAID_HELPERS.test(src);
  const reserves = (src.match(/reserveBudget\(budget/g) ?? []).length;
  const confirms = (src.match(/confirmSpend\(server/g) ?? []).length;
  const imports = /from "\.\.\/utils\/confirm-spend\.js"/.test(src);
  const paid = paidSurface || reserves > 0;
  if (!paid) return { paid, reserves, confirms, imports, offence: null };
  if (paidSurface && reserves === 0 && file in FREE_BY_DESIGN) return { paid, reserves, confirms, imports, offence: null };
  // No parity requirement between reserves and confirms: speech, video and
  // image legitimately RE-reserve inside a 402 onQuote after the one confirm.
  let offence: string | null = null;
  if (reserves === 0) offence = "pays but never reserves budget";
  else if (!imports || confirms === 0) offence = "reserves budget but never asks (confirmSpend)";
  return { paid, reserves, confirms, imports, offence };
}

test("every tool that can pay reserves budget AND asks the user (confirmSpend)", () => {
  const offenders: string[] = [];
  for (const file of readdirSync(TOOLS_DIR).filter((f) => f.endsWith(".ts"))) {
    const c = classifyToolSource(file, readFileSync(join(TOOLS_DIR, file), "utf8"));
    if (c.offence) offenders.push(`${file}: ${c.offence} (reserves=${c.reserves}, confirms=${c.confirms})`);
  }
  assert.deepEqual(
    offenders,
    [],
    `paid tools that bypass the budget cap or BLOCKRUN_CONFIRM_SPEND:\n  ${offenders.join("\n  ")}`,
  );
});

test("the FREE_BY_DESIGN allowlist names only files that still exist and still import a paid surface", () => {
  // A stale entry is a hole: rename models.ts, add a paid call to the new
  // file, and the old name would keep excusing nothing while the new one is
  // judged normally — fine. But an entry whose file no longer imports a paid
  // surface is dead weight that invites copy-paste, so it must go.
  for (const file of Object.keys(FREE_BY_DESIGN)) {
    const src = readFileSync(join(TOOLS_DIR, file), "utf8");
    const walletImport = /import\s*\{([^}]*)\}\s*from\s*"\.\.\/utils\/wallet\.js"/.exec(src)?.[1] ?? "";
    assert.ok(PAID_CLIENTS.test(walletImport) || PAID_HELPERS.test(src), `${file} no longer imports a paid surface — drop it from FREE_BY_DESIGN`);
    assert.equal((src.match(/reserveBudget\(budget/g) ?? []).length, 0, `${file} now reserves budget — it is a paid tool, drop it from FREE_BY_DESIGN`);
  }
});

test("the static guard bites: a tool that pays without reserving, or reserves without asking, is an offender", () => {
  const RESERVE = "const gate = reserveBudget(budget, agent_id, 0.01);";
  const CONFIRM = 'import { confirmSpend } from "../utils/confirm-spend.js";\nconst c = await confirmSpend(server, { usd: 0.01, label: "x" });';
  const client = 'import { getClient } from "../utils/wallet.js";';
  const helper = 'import { apiKeyPost } from "../utils/api-key-call.js";';
  const freeWallet = 'import { getWalletInfo, getChain } from "../utils/wallet.js";';

  // The hole this test closes: pays via a client, never reserves → was skipped.
  assert.equal(classifyToolSource("new.ts", `${client}\n${CONFIRM}`).offence, "pays but never reserves budget");
  assert.equal(classifyToolSource("new.ts", `${helper}`).offence, "pays but never reserves budget");
  // The original rule, still enforced.
  assert.equal(classifyToolSource("new.ts", `${client}\n${RESERVE}`).offence, "reserves budget but never asks (confirmSpend)");
  assert.equal(classifyToolSource("new.ts", `${RESERVE}`).offence, "reserves budget but never asks (confirmSpend)", "reserving via an unknown helper is still held to the confirm");
  // Compliant, including the legitimate re-reserve pattern (2 reserves, 1 confirm).
  assert.equal(classifyToolSource("new.ts", `${client}\n${RESERVE}\n${CONFIRM}`).offence, null);
  assert.equal(classifyToolSource("new.ts", `${helper}\n${RESERVE}\n${RESERVE}\n${CONFIRM}`).offence, null);
  // Free tools: wallet-status imports and no rail are not paid at all.
  assert.deepEqual(classifyToolSource("free.ts", `${freeWallet}`), { paid: false, reserves: 0, confirms: 0, imports: false, offence: null });
  // The allowlist excuses a paid-surface importer only under its own name.
  assert.equal(classifyToolSource("models.ts", `${client}`).offence, null);
  assert.equal(classifyToolSource("models-v2.ts", `${client}`).offence, "pays but never reserves budget");
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
    getApiBase: () => "https://blockrun.ai/api",
    resolveGatewayUrl: (u: string) => (u.startsWith("http") ? u : `https://blockrun.ai/api${u.startsWith("/api/") ? u.slice(4) : u}`),

    getChain: () => "base",
    getClient: () => trap,
    buildClient: () => trap,
    buildClientWithTimeout: () => trap,
    getPriceClient: () => trap,
    getAnthropicClient: () => trap,
    // blockrun_image: its Base rail is the SDK ImageClient, and image.ts
    // statically imports utils/solana-402.ts, which resolves the Solana key
    // through wallet.ts (image-cost.test.ts documents the same two exports).
    getImageClient: () => trap,
    resolveSolanaKey: () => undefined,
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
  // The tool named on line 6 as the one that historically DID confirm — and
  // then the only paid tool this table did not cover. zai/cogview-4 is in
  // IMAGE_MODELS, so the request clears the z.enum pre-gate.
  { tool: "blockrun_image", mod: "image", register: "registerImageTool", args: { prompt: "a cube", model: "zai/cogview-4" } },
  { tool: "blockrun_exa", mod: "exa", register: "registerExaTool", args: { path: "search", body: { query: "rag papers" } } },
  { tool: "blockrun_phone", mod: "phone", register: "registerPhoneTool", args: { path: "phone/lookup", body: { phone: "+14155550100" } } },
  { tool: "blockrun_modal", mod: "modal", register: "registerModalTool", args: { path: "sandbox/create", body: {} } },
  { tool: "blockrun_rpc", mod: "rpc", register: "registerRpcTool", args: { network: "ethereum", method: "eth_blockNumber" } },
  // blockrun_price has no reachable paid path while equity is withdrawn: since
  // 2026-09-05 the gateway 501s stocks price/history before payment, and the
  // tool says so before reserveBudget/confirmSpend. That ORDERING is proved at
  // handler level in test/price-behaviour.test.ts (the wording in
  // test/price-equity-preflight.test.ts), so this row's absence is not a gap.
  // Do not substitute a crypto/fx row: those reserve $0, confirmSpend
  // short-circuits at usd <= 0, and the handler would hit the trap — the
  // decline assertions below cannot hold for a free call. The static guard
  // above still holds price.ts to the reserve+confirm shape, so re-adding this
  // row is all it takes when the equity route returns:
  //   { tool: "blockrun_price", mod: "price", register: "registerPriceTool", args: { action: "price", category: "stocks", symbol: "AAPL", market: "us" } },
  // blockrun_surf has no reachable paid path either: Surf was retired upstream on
  // 2026-09-06 (every /v1/surf/* path answers 410 endpoint_retired, no 402 is
  // ever issued), and the tool returns the retirement notice BEFORE
  // reserveBudget/confirmSpend. That ordering — no reservation, no dialog, no
  // network — is proved at handler level in test/surf-retired.test.ts. The
  // static guard above still holds surf.ts to the reserve+confirm shape, so
  // re-adding this row is all it takes if the gateway revives the namespace (or
  // ships its replacement vendor under the same tool):
  //   { tool: "blockrun_surf", mod: "surf", register: "registerSurfTool", args: { path: "market/price", params: { symbol: "ETH" } } },
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
