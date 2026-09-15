// Run with: npm test  (tsx --experimental-test-module-mocks --test)
//
// blockrun_chat on the ACCOUNT rail (BLOCKRUN_API_KEY): what gets booked, and
// what the caller is told, for every way a call can end.
//
// The 0.50.0 fix for "a billed-then-dropped stream booked $0" made the account
// branch of withSettledCost treat EVERY rejection as a billed call: a 400
// (typo'd model), a 401, a 402 out-of-credit, a 60s free-tier timeout — all
// booked the full gate reserve, all printed "the gateway had already accepted
// and billed this request … retrying will incur a second charge", and all
// broke the routing loop before a second candidate was tried. Five typos
// exhausted a delegated cap with $0 actually billed, and mode:"free" was
// single-shot on this rail (audit round 3: C5/C18/C23/C31).
//
// The account rail CAN tell these apart: the SDK's ApiKeyAuth.fetch throws an
// APIError carrying the status of the first response, before any body exists —
// nothing was accepted. Only a failure AFTER a 2xx is a billed call. And on
// success the rail may carry `x-blockrun-cost-usd`; when it does, THAT is the
// ledger entry (a settled zero included), and when it does not, the entry is a
// ledger estimate at the served model's own rate — never the gate reserve,
// which prices the worst member of the tier at full max_tokens plus a fee this
// rail does not charge (C33/D53).
//
// No network, no key that works anywhere: the client is a fake LLMClient whose
// chatCompletionStream() answers with a scripted Response or throws the same
// error shapes the SDK does.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import type { BudgetState } from "../src/types.js";
import { CHAT_PRICE_PER_MTOKEN, MODEL_TIERS } from "../src/utils/constants.js";

// Drive account mode through the env var rather than mocking auth.js: the mode
// is derived from BLOCKRUN_API_KEY, and replacing that module wholesale drops
// exports other modules import.
process.env.BLOCKRUN_API_KEY = "brk_live_testkeyfortestsonly0000";

type Attempt =
  | { kind: "reject"; status: number }
  | { kind: "abort" }
  | { kind: "midstream"; partial: string }
  | { kind: "ok"; text: string; costHeader?: string; usage?: { prompt: number; completion: number }; served?: string; finish?: string };

let script: Map<string, Attempt>;
let attempts: string[];
const enc = new TextEncoder();

function sse(frames: unknown[], headers: Record<string, string> = {}): Response {
  const lines = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).concat("data: [DONE]\n\n");
  return new Response(
    new ReadableStream<Uint8Array>({ start(c) { for (const l of lines) c.enqueue(enc.encode(l)); c.close(); } }),
    { status: 200, headers: { "content-type": "text/event-stream", ...headers } },
  );
}

// The SDK's account transport: `throw new APIError("BlockRun account API error: 402. Top up at …", 402)`.
function apiError(status: number): Error {
  const hint = status === 402 ? " Top up at https://user.blockrun.ai/dashboard/credits." : "";
  return Object.assign(new Error(`BlockRun account API error: ${status}.${hint}`), { name: "APIError", statusCode: status });
}

function makeFakeClient() {
  return {
    // The account rail has no settlement counter — the real SDK THROWS here.
    getSpending: () => { throw new Error("Account usage is available at the dashboard; getSpending() tracks x402 settlements only."); },
    // The free tier runs non-streaming on the short-timeout client; same script.
    chatCompletion: async (model: string) => {
      attempts.push(model);
      const a = script.get(model) ?? { kind: "ok", text: `reply from ${model}` };
      if (a.kind === "reject") throw apiError(a.status);
      if (a.kind === "abort") throw Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
      if (a.kind === "midstream") throw new Error("not scripted for the non-streaming fake");
      return { model: a.served ?? model, choices: [{ message: { content: a.text }, finish_reason: a.finish ?? "stop" }] };
    },
    chatCompletionStream: async (model: string) => {
      attempts.push(model);
      const a = script.get(model) ?? { kind: "ok", text: `reply from ${model}` };
      if (a.kind === "reject") throw apiError(a.status);
      if (a.kind === "abort") throw Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
      if (a.kind === "midstream") {
        return sse([
          { model, choices: [{ delta: { content: a.partial } }] },
          { error: { message: "upstream exploded" } },
        ]);
      }
      const served = a.served ?? model;
      return sse([
        { model: served, choices: [{ delta: { content: a.text }, finish_reason: null }] },
        { model: served, choices: [{ delta: {}, finish_reason: a.finish ?? "stop" }] },
        ...(a.usage ? [{ model: served, choices: [], usage: { prompt_tokens: a.usage.prompt, completion_tokens: a.usage.completion } }] : []),
      ], a.costHeader !== undefined ? { "x-blockrun-cost-usd": a.costHeader } : {});
    },
  };
}

mock.module("../src/utils/wallet.js", {
  namedExports: {
    getApiBase: () => "https://api.blockrun.ai",
    resolveGatewayUrl: (u: string) => u,
    getChain: () => "solana", // the account rail must win over the chain
    buildClient: () => makeFakeClient(),
    buildClientWithTimeout: () => makeFakeClient(),
    getOrCreateWalletKey: () => { throw new Error("account rail must not touch a wallet key"); },
    getWalletInfo: async () => ({ address: "0xTEST" }),
    getAnthropicClient: () => { throw new Error("not used"); },
    baseOnlyMessage: () => null,
  },
});

const { registerChatTool, estimateChatCost } = await import("../src/tools/chat.js");

type Result = { content: Array<{ type: string; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };
function makeHarness(limit = 100) {
  const budget: BudgetState = { spent: 0, calls: 0, limit, agents: new Map() };
  let handler: (args: Record<string, unknown>) => Promise<Result>;
  const server = {
    registerTool: (_n: string, _c: unknown, h: typeof handler) => { handler = h; },
  } as unknown as Parameters<typeof registerChatTool>[0];
  registerChatTool(server, budget);
  return { budget, call: (args: Record<string, unknown>) => handler!(args) };
}

const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
// The ledger books whole micro-dollars, rounded up (the gateway bills that way).
const micro = (usd: number) => Math.ceil(usd * 1e6 - 1e-6) / 1e6;

test("account rail: a 402 out-of-credit refusal books $0 and is not reported as billed", async () => {
  script = new Map([["openai/gpt-5.6-terra", { kind: "reject", status: 402 }]]);
  attempts = [];
  const { budget, call } = makeHarness();

  const res = await call({ message: "hi", model: "openai/gpt-5.6-terra", max_tokens: 1024, temperature: 1 });

  assert.equal(res.isError, true);
  assert.equal(budget.spent, 0, `a refusal before any body settles nothing (booked ${budget.spent})`);
  assert.match(res.content[0].text, /Top up/, res.content[0].text);
  // The SDK threw from the first non-OK response: nothing was accepted, so the
  // text must not claim a charge or warn the caller off a retry.
  assert.doesNotMatch(res.content[0].text, /charge stands|has been billed|is billed|second charge|already accepted/i, res.content[0].text);
});

test("account rail: a 400 (typo'd model) books $0 — five typos must not exhaust a delegated cap", async () => {
  script = new Map([["openai/gpt-5.6-tera", { kind: "reject", status: 400 }]]);
  attempts = [];
  const { budget, call } = makeHarness();
  budget.agents.set("a1", { limit: 0.1, spent: 0, calls: 0 });

  for (let i = 0; i < 5; i++) {
    const res = await call({ message: "hi", model: "openai/gpt-5.6-tera", max_tokens: 1024, temperature: 1, agent_id: "a1" });
    assert.equal(res.isError, true);
    assert.doesNotMatch(res.content[0].text, /charge stands|billed|second charge/i, res.content[0].text);
  }
  assert.equal(budget.spent, 0);
  assert.equal(budget.agents.get("a1")!.spent, 0, "phantom spend must not consume the agent's cap");
  assert.equal(attempts.length, 5, "each call reached the gateway — the cap was never falsely tripped");
});

test("account rail: the routing loop falls through a pre-accept refusal to the next model", async () => {
  script = new Map([
    ["deepseek/deepseek-v4-pro", { kind: "reject", status: 429 }],
    ["qwen/qwen3.7-flash", { kind: "ok", text: "qwen answers", usage: { prompt: 100, completion: 50 } }],
  ]);
  attempts = [];
  const { budget, call } = makeHarness();

  const res = await call({ message: "hi", mode: "cheap", max_tokens: 1024, temperature: 1 });

  assert.equal(res.isError, undefined, res.content[0].text);
  assert.deepEqual(attempts, ["deepseek/deepseek-v4-pro", "qwen/qwen3.7-flash"], "a 429 before any body must not end the loop");
  // Booked at the SERVED model's own rate from the usage the stream reported,
  // with no transaction fee — not the tier's worst member at full max_tokens.
  const rate = CHAT_PRICE_PER_MTOKEN["qwen/qwen3.7-flash"];
  const expected = micro((100 * rate.input + 50 * rate.output) / 1e6);
  assert.ok(near(budget.spent, expected), `booked ${budget.spent}, expected the usage-based ${expected}`);
  const reserve = estimateChatCost(1024, "cheap", undefined, undefined, 2);
  assert.ok(budget.spent < reserve / 10, `the gate reserve (${reserve}) must not be what the ledger books`);
});

test("account rail: mode:\"free\" keeps falling through after a timeout and a refusal, and books $0", async () => {
  const [first, second, third] = MODEL_TIERS.free;
  script = new Map<string, Attempt>([
    [first, { kind: "abort" }],
    [second, { kind: "reject", status: 429 }],
    [third, { kind: "ok", text: "free answer" }],
  ]);
  attempts = [];
  const { budget, call } = makeHarness();

  const res = await call({ message: "hi", mode: "free", max_tokens: 1024, temperature: 1 });

  assert.equal(res.isError, undefined, res.content[0].text);
  assert.deepEqual(attempts, [first, second, third], "a $0 tier can never have been billed — the loop must walk on");
  assert.equal(budget.spent, 0);
});

test("account rail: a failure AFTER the 200 is billed — booked at the model's ledger rate, said plainly, partial text kept", async () => {
  script = new Map([["openai/gpt-5.6-terra", { kind: "midstream", partial: "the first 900 tokens" }]]);
  attempts = [];
  const { budget, call } = makeHarness();

  const res = await call({ message: "hi", model: "openai/gpt-5.6-terra", max_tokens: 1024, temperature: 1 });

  assert.equal(res.isError, true);
  // Accepted with a 200, so the account is billed at exact usage. No usage
  // arrived, so the entry is the model's own rate over the prompt and the full
  // max_tokens — no tier worst-case, no transaction fee.
  const rate = CHAT_PRICE_PER_MTOKEN["openai/gpt-5.6-terra"];
  const expected = micro((Math.ceil(2 / 2.08) * rate.input + 1024 * rate.output) / 1e6);
  assert.ok(near(budget.spent, expected), `booked ${budget.spent}, expected ${expected}`);
  assert.ok(budget.spent < estimateChatCost(1024, undefined, "openai/gpt-5.6-terra", undefined, 2), "must book below the gate reserve");
  assert.match(res.content[0].text, /accepted/i, res.content[0].text);
  assert.match(res.content[0].text, /billed/i, res.content[0].text);
  assert.match(res.content[0].text, /second charge/i, res.content[0].text);
  assert.doesNotMatch(res.content[0].text, /needs funding/, res.content[0].text);
  // The 900 tokens the caller paid for are surfaced, not discarded.
  assert.match(res.content[0].text, /the first 900 tokens/, res.content[0].text);
  assert.equal(res.structuredContent?.partial_response, "the first 900 tokens");
});

test("account rail: a timeout with no response observed MAY have been billed — booked as a precaution, no fallback", async () => {
  script = new Map([
    ["deepseek/deepseek-v4-pro", { kind: "abort" }],
    ["qwen/qwen3.7-flash", { kind: "ok", text: "never reached" }],
  ]);
  attempts = [];
  const { budget, call } = makeHarness();

  const res = await call({ message: "hi", mode: "cheap", max_tokens: 1024, temperature: 1 });

  assert.equal(res.isError, true);
  assert.deepEqual(attempts, ["deepseek/deepseek-v4-pro"], "a paid call that may have been billed must not be followed by a second paid model");
  assert.ok(budget.spent > 0, "the precautionary booking must land");
  assert.match(res.content[0].text, /may have been billed/i, res.content[0].text);
  assert.doesNotMatch(res.content[0].text, /charge stands/, "no charge is certain here");
});

test("account rail: x-blockrun-cost-usd on the response is the ledger entry, exactly", async () => {
  script = new Map([["openai/gpt-5.6-terra", { kind: "ok", text: "hello", costHeader: "0.003100", usage: { prompt: 5000, completion: 900 } }]]);
  attempts = [];
  const { budget, call } = makeHarness();

  const res = await call({ message: "hi", model: "openai/gpt-5.6-terra", max_tokens: 1024, temperature: 1 });

  assert.equal(res.isError, undefined, res.content[0].text);
  assert.ok(near(budget.spent, 0.0031), `booked ${budget.spent}, header said 0.0031`);
  assert.equal(res.structuredContent?.cost_usd, 0.0031);
  assert.equal(res.structuredContent?.cost_is_estimate, false);
  assert.doesNotMatch(res.content[0].text, /~\$/, "a settled figure is not printed as an estimate");
});

test("account rail: a settled ZERO in the header books $0, not the estimate", async () => {
  script = new Map([["openai/gpt-5.6-terra", { kind: "ok", text: "hello", costHeader: "0.000000", usage: { prompt: 5000, completion: 900 } }]]);
  attempts = [];
  const { budget, call } = makeHarness();

  await call({ message: "hi", model: "openai/gpt-5.6-terra", max_tokens: 1024, temperature: 1 });

  assert.equal(budget.spent, 0, `the gateway priced this at zero; booked ${budget.spent}`);
  assert.equal(budget.calls, 1);
});

test("account rail: without the header the ledger is the served model's rate over reported usage, labelled as an estimate", async () => {
  script = new Map([["openai/gpt-5.6-terra", { kind: "ok", text: "hello", usage: { prompt: 100, completion: 50 } }]]);
  attempts = [];
  const { budget, call } = makeHarness();

  const res = await call({ message: "hi", model: "openai/gpt-5.6-terra", max_tokens: 1024, temperature: 1 });

  const rate = CHAT_PRICE_PER_MTOKEN["openai/gpt-5.6-terra"];
  const expected = micro((100 * rate.input + 50 * rate.output) / 1e6);
  assert.ok(near(budget.spent, expected), `booked ${budget.spent}, expected ${expected}`);
  assert.equal(res.structuredContent?.cost_is_estimate, true);
  assert.match(res.content[0].text, /~\$0\.0008/, res.content[0].text);
  assert.match(res.content[0].text, /exact usage/i, res.content[0].text);
});

test("account rail: the multi-turn path books the same way", async () => {
  script = new Map([["openai/gpt-5.6-terra", { kind: "ok", text: "and so on", usage: { prompt: 200, completion: 20 } }]]);
  attempts = [];
  const { budget, call } = makeHarness();

  const res = await call({
    message: "and then?",
    model: "openai/gpt-5.6-terra",
    messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }],
    max_tokens: 1024,
    temperature: 1,
  });

  assert.equal(res.isError, undefined, res.content[0].text);
  const rate = CHAT_PRICE_PER_MTOKEN["openai/gpt-5.6-terra"];
  assert.ok(near(budget.spent, micro((200 * rate.input + 20 * rate.output) / 1e6)), `booked ${budget.spent}`);
});

test("account rail: a free request served under another (unpriced) id still books $0", async () => {
  // The gateway's free fallback answers a free id from whatever has capacity;
  // the alias target has no price row. Booking DEFAULT_CHAT_PRICE for that
  // would charge the ledger $5/$30 for a call the gateway served free.
  const [first] = MODEL_TIERS.free;
  script = new Map<string, Attempt>([[first, { kind: "ok", text: "free", served: "nvidia/nemotron-3-super-120b", usage: { prompt: 900, completion: 40 } }]]);
  attempts = [];
  const { budget, call } = makeHarness();

  const res = await call({ message: "hi", mode: "free", max_tokens: 1024, temperature: 1 });

  assert.equal(res.isError, undefined, res.content[0].text);
  assert.equal(budget.spent, 0, `booked ${budget.spent} for a free call`);
  assert.equal(res.structuredContent?.served_model, "nvidia/nemotron-3-super-120b");
});

test("account rail: a paid request answered by a priced alias is booked at the alias's rate", async () => {
  script = new Map<string, Attempt>([["moonshot/kimi-k2.6", { kind: "ok", text: "k3", served: "moonshot/kimi-k3", usage: { prompt: 1000, completion: 100 } }]]);
  attempts = [];
  const { budget, call } = makeHarness();

  await call({ message: "hi", model: "moonshot/kimi-k2.6", max_tokens: 1024, temperature: 1 });

  const rate = CHAT_PRICE_PER_MTOKEN["moonshot/kimi-k3"];
  assert.ok(near(budget.spent, micro((1000 * rate.input + 100 * rate.output) / 1e6)), `booked ${budget.spent}`);
});
