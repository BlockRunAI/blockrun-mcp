// Run with: npm test  (tsx --experimental-test-module-mocks --test)
//
// The wallet rails, for the failure the getSpending() delta cannot see.
//
// withSettledCost books a settled-then-failed call from the SDK's own spend
// counter, which the SDK increments only AFTER the paid retry came back OK:
// LLMClient.chatCompletionStream throws `API error after payment: <status>`
// BEFORE `sessionTotalUsd += costUsd`, and SolanaLLMClient.handlePaymentAndRetry
// runs assertPaid() before recordSettlement() — and fetchWithTimeout aborts the
// paid retry with no counter movement at all (60s on Solana, the default chain).
// So a 524 from the edge or a client-side abort on a slow generation arrived
// with a signed payment already sent, the delta read 0, nothing was booked, the
// text said "temporary API issue — try again", and the routing loop signed a
// SECOND payment for the next model under the same reservation (audit round 3,
// C19). The gateway settles those after the client has given up.
//
// This process cannot know whether such a payment settled. What it can do is
// refuse to pay again, book the reserve as a precaution, and say so. That is
// what these pin — on Solana (the default) and on Base alike — together with
// the shapes that are NOT payments: an unpaid first-response 4xx, and a 4xx
// after payment, which the gateway answers before settlement starts.
//
// Also pinned here, because they come off the same stream: the id the gateway
// says answered (D55) and a reply cut at max_tokens (D57).
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import type { BudgetState } from "../src/types.js";

type Fail = false | "unpaid-400" | "after-payment-524" | "after-payment-400" | "abort" | "midstream";
type Attempt = { settleUsd: number; fail: Fail; served?: string; finish?: string; text?: string };
let script: Map<string, Attempt>;
let attempts: string[];
let chain: "base" | "solana" = "solana";
const enc = new TextEncoder();

function apiError(message: string, statusCode: number): Error {
  return Object.assign(new Error(message), { name: "APIError", statusCode });
}
function abortError(): Error {
  return Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
}

// What the paid retry does, before any body: the money moves (or not) HERE.
function paidRetry(model: string, total: { usd: number }): { a: Attempt; frames: unknown[] } {
  attempts.push(model);
  const a = script.get(model) ?? { settleUsd: 0, fail: false };
  if (a.fail === "unpaid-400") throw apiError("API error: 400", 400);
  if (a.fail === "after-payment-400") throw apiError("API error after payment: 400", 400);
  if (a.fail === "after-payment-524") throw apiError("API error after payment: 524", 524);
  if (a.fail === "abort") throw abortError();
  // A 200: the SDK counts the settlement before the body is read.
  total.usd += a.settleUsd;
  const served = a.served ?? model;
  const frames: unknown[] = a.fail === "midstream"
    ? [{ model: served, choices: [{ delta: { content: "partial " } }] }, { error: { message: "upstream exploded" } }]
    : [
        { model: served, choices: [{ delta: { content: a.text ?? `reply from ${model}` }, finish_reason: null }] },
        { model: served, choices: [{ delta: {}, finish_reason: a.finish ?? "stop" }] },
        { model: served, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
      ];
  return { a, frames };
}

// SolanaLLMClient: no chatCompletionStream; `stream()` yields decoded frames
// and records the settlement before the first one.
function makeSolanaFake() {
  const total = { usd: 0 };
  return {
    getSpending: () => ({ totalUsd: total.usd }),
    chatCompletion: async (model: string) => {
      const { frames } = paidRetry(model, total);
      const text = frames.map((f) => (f as { choices?: Array<{ delta?: { content?: string } }> }).choices?.[0]?.delta?.content ?? "").join("");
      return { model, choices: [{ message: { content: text }, finish_reason: "stop" }] };
    },
    stream: async function* (_path: string, body: Record<string, unknown>) {
      const { frames } = paidRetry(String(body.model), total);
      for (const f of frames) yield f;
    },
  };
}

// LLMClient on Base: chatCompletionStream returns the paid Response.
function makeBaseFake() {
  const total = { usd: 0 };
  return {
    getSpending: () => ({ totalUsd: total.usd }),
    chatCompletion: async (model: string) => {
      const { a } = paidRetry(model, total);
      return { model: a.served ?? model, choices: [{ message: { content: a.text ?? `reply from ${model}` }, finish_reason: a.finish ?? "stop" }] };
    },
    chatCompletionStream: async (model: string) => {
      const { frames } = paidRetry(model, total);
      const lines = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).concat("data: [DONE]\n\n");
      return new Response(
        new ReadableStream<Uint8Array>({ start(c) { for (const l of lines) c.enqueue(enc.encode(l)); c.close(); } }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    },
  };
}

mock.module("../src/utils/wallet.js", {
  namedExports: {
    getApiBase: () => "https://blockrun.ai/api",
    resolveGatewayUrl: (u: string) => u,
    getChain: () => chain,
    buildClient: () => (chain === "solana" ? makeSolanaFake() : makeBaseFake()),
    buildClientWithTimeout: () => (chain === "solana" ? makeSolanaFake() : makeBaseFake()),
    getOrCreateWalletKey: () => "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    getWalletInfo: async () => ({ address: "0xTEST" }),
    getAnthropicClient: () => { throw new Error("native AnthropicClient was built"); },
    // The real one: a Solana wallet gets the refusal text, Base gets null.
    baseOnlyMessage: (capability: string) => (chain === "solana"
      ? `${capability} currently supports Base-chain payment only — your active chain is Solana. Switch with: blockrun_wallet action:"chain" chain:"base"`
      : null),
  },
});

const { registerChatTool, estimateChatCost } = await import("../src/tools/chat.js");

type Result = { content: Array<{ type: string; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };
function makeHarness() {
  const budget: BudgetState = { spent: 0, calls: 0, limit: 100, agents: new Map() };
  let handler: (args: Record<string, unknown>) => Promise<Result>;
  const server = {
    registerTool: (_n: string, _c: unknown, h: typeof handler) => { handler = h; },
  } as unknown as Parameters<typeof registerChatTool>[0];
  registerChatTool(server, budget);
  return { budget, call: (args: Record<string, unknown>) => handler!(args) };
}
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

for (const c of ["solana", "base"] as const) {
  test(`${c}: a 524 after payment with no counter movement is booked as a precaution and ends the loop`, async () => {
    chain = c;
    script = new Map([
      ["deepseek/deepseek-v4-pro", { settleUsd: 0, fail: "after-payment-524" }],
      ["qwen/qwen3.7-flash", { settleUsd: 0.0031, fail: false }],
    ]);
    attempts = [];
    const { budget, call } = makeHarness();

    const res = await call({ message: "hi", mode: "cheap", max_tokens: 1024, temperature: 1 });

    assert.equal(res.isError, true);
    assert.deepEqual(attempts, ["deepseek/deepseek-v4-pro"], "a payment that may have settled must not be followed by a second signed payment");
    const reserve = estimateChatCost(1024, "cheap", undefined, undefined, 2);
    assert.ok(near(budget.spent, reserve), `the reserve (${reserve}) is booked as the precaution; got ${budget.spent}`);
    assert.match(res.content[0].text, /may have settled|cannot tell whether/i, res.content[0].text);
    assert.match(res.content[0].text, /second charge/i, res.content[0].text);
    assert.doesNotMatch(res.content[0].text, /needs funding/, res.content[0].text);
  });

  test(`${c}: an abort on a paid explicit model books the reserve and says the payment may have settled`, async () => {
    chain = c;
    script = new Map([["openai/gpt-5.6-terra", { settleUsd: 0, fail: "abort" }]]);
    attempts = [];
    const { budget, call } = makeHarness();

    const res = await call({ message: "hi", model: "openai/gpt-5.6-terra", max_tokens: 1024, temperature: 1 });

    assert.equal(res.isError, true);
    const reserve = estimateChatCost(1024, undefined, "openai/gpt-5.6-terra", undefined, 2);
    assert.ok(near(budget.spent, reserve), `booked ${budget.spent}, reserve ${reserve}`);
    assert.match(res.content[0].text, /may have settled|cannot tell whether/i, res.content[0].text);
    assert.doesNotMatch(res.content[0].text, /charge stands/, "no charge is certain here");
  });

  test(`${c}: an unpaid first-response 400 books nothing and the loop falls through`, async () => {
    chain = c;
    script = new Map([
      ["deepseek/deepseek-v4-pro", { settleUsd: 0, fail: "unpaid-400" }],
      ["qwen/qwen3.7-flash", { settleUsd: 0.0031, fail: false }],
    ]);
    attempts = [];
    const { budget, call } = makeHarness();

    const res = await call({ message: "hi", mode: "cheap", max_tokens: 1024, temperature: 1 });

    assert.equal(res.isError, undefined, res.content[0].text);
    assert.deepEqual(attempts, ["deepseek/deepseek-v4-pro", "qwen/qwen3.7-flash"]);
    assert.ok(near(budget.spent, 0.0031), `only the second model settled; booked ${budget.spent}`);
  });

  test(`${c}: a 4xx AFTER payment is refused before settlement — nothing booked, loop continues`, async () => {
    // The gateway answers a 4xx on the paid retry from its own handler, before
    // streamAIProvider has returned a stream handle — "settlement has not
    // started" in its own words — so this is not money.
    chain = c;
    script = new Map([
      ["deepseek/deepseek-v4-pro", { settleUsd: 0, fail: "after-payment-400" }],
      ["qwen/qwen3.7-flash", { settleUsd: 0.0031, fail: false }],
    ]);
    attempts = [];
    const { budget, call } = makeHarness();

    const res = await call({ message: "hi", mode: "cheap", max_tokens: 1024, temperature: 1 });

    assert.equal(res.isError, undefined, res.content[0].text);
    assert.deepEqual(attempts, ["deepseek/deepseek-v4-pro", "qwen/qwen3.7-flash"]);
    assert.ok(near(budget.spent, 0.0031), `booked ${budget.spent}`);
  });

  test(`${c}: a free model that aborts is never "may have settled" — the free tier walks on`, async () => {
    chain = c;
    const free = ["nvidia/gpt-oss-20b", "cohere/north-mini-code", "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning"];
    script = new Map([[free[0], { settleUsd: 0, fail: "abort" }], [free[1], { settleUsd: 0, fail: "after-payment-524" }]]);
    attempts = [];
    const { budget, call } = makeHarness();

    const res = await call({ message: "hi", mode: "free", max_tokens: 1024, temperature: 1 });

    assert.equal(res.isError, undefined, res.content[0].text);
    assert.ok(attempts.length >= 3, `expected the loop to reach a third free model, got ${attempts.join(", ")}`);
    assert.equal(budget.spent, 0);
  });

  test(`${c}: a stream that settled and then died books the counter's delta and keeps the partial text`, async () => {
    chain = c;
    script = new Map([["openai/gpt-5.6-terra", { settleUsd: 0.0412, fail: "midstream" }]]);
    attempts = [];
    const { budget, call } = makeHarness();

    const res = await call({ message: "hi", model: "openai/gpt-5.6-terra", max_tokens: 1024, temperature: 1 });

    assert.equal(res.isError, true);
    assert.ok(near(budget.spent, 0.0412), `booked ${budget.spent}`);
    assert.match(res.content[0].text, /charge stands \(\$0\.041200\)/, res.content[0].text);
    assert.match(res.content[0].text, /partial /, "the paid partial text must be surfaced");
    assert.equal(res.structuredContent?.partial_response, "partial ");
  });

  test(`${c}: a paid call that streams to completion books the settled delta once and reports what served`, async () => {
    chain = c;
    script = new Map([["openai/gpt-5.6-terra", { settleUsd: 0.0217, fail: false, served: "openai/gpt-5.6-terra", text: "done" }]]);
    attempts = [];
    const { budget, call } = makeHarness();

    const res = await call({ message: "hi", model: "openai/gpt-5.6-terra", max_tokens: 1024, temperature: 1 });

    assert.equal(res.isError, undefined, res.content[0].text);
    assert.deepEqual(attempts, ["openai/gpt-5.6-terra"]);
    assert.ok(near(budget.spent, 0.0217), `booked ${budget.spent}`);
    assert.equal(budget.calls, 1);
    assert.match(res.content[0].text, /done/);
    assert.equal(res.structuredContent?.served_model, "openai/gpt-5.6-terra");
    assert.equal(res.structuredContent?.finish_reason, "stop");
  });
}

test("D55: an aliased id is reported under the id that actually answered", async () => {
  chain = "solana";
  script = new Map([["moonshot/kimi-k2.6", { settleUsd: 0.0105, fail: false, served: "moonshot/kimi-k3", text: "kimi here" }]]);
  attempts = [];
  const { call } = makeHarness();

  const res = await call({ message: "hi", model: "moonshot/kimi-k2.6", max_tokens: 1024, temperature: 1 });

  assert.equal(res.isError, undefined, res.content[0].text);
  assert.equal(res.structuredContent?.served_model, "moonshot/kimi-k3");
  assert.equal(res.structuredContent?.model_used, "moonshot/kimi-k2.6", "what was asked for stays visible too");
  assert.match(res.content[0].text, /served by moonshot\/kimi-k3/i, res.content[0].text);
});

test("D55: the routing loop's header names the served model when it differs", async () => {
  chain = "base";
  const free0 = "nvidia/gpt-oss-20b";
  script = new Map([[free0, { settleUsd: 0, fail: false, served: "nvidia/nemotron-3-super-120b", text: "free reply" }]]);
  attempts = [];
  const { call } = makeHarness();

  const res = await call({ message: "hi", mode: "free", max_tokens: 1024, temperature: 1 });

  assert.equal(res.isError, undefined, res.content[0].text);
  assert.equal(res.structuredContent?.served_model, "nvidia/nemotron-3-super-120b");
  assert.match(res.content[0].text, /nemotron-3-super-120b/, res.content[0].text);
});

test("D57: a reply cut at max_tokens is flagged, on the explicit and the routed path", async () => {
  chain = "base";
  script = new Map([
    ["openai/gpt-5.6-terra", { settleUsd: 0.01, fail: false, finish: "length", text: '{"partial": tru' }],
    ["deepseek/deepseek-v4-pro", { settleUsd: 0.01, fail: false, finish: "length", text: "cut off mid" }],
  ]);
  attempts = [];
  const { call } = makeHarness();

  const explicit = await call({ message: "hi", model: "openai/gpt-5.6-terra", max_tokens: 200, temperature: 1 });
  assert.equal(explicit.isError, undefined, explicit.content[0].text);
  assert.match(explicit.content[0].text, /TRUNCATED OUTPUT/, explicit.content[0].text);
  assert.match(explicit.content[0].text, /max_tokens=200/, explicit.content[0].text);
  assert.equal(explicit.structuredContent?.truncated_output, true);
  assert.equal(explicit.structuredContent?.finish_reason, "length");

  const routed = await call({ message: "hi", mode: "cheap", max_tokens: 200, temperature: 1 });
  assert.equal(routed.isError, undefined, routed.content[0].text);
  assert.match(routed.content[0].text, /TRUNCATED OUTPUT/, routed.content[0].text);
  assert.equal(routed.structuredContent?.truncated_output, true);
});

test("a complete reply carries no truncation note", async () => {
  chain = "base";
  script = new Map([["openai/gpt-5.6-terra", { settleUsd: 0.01, fail: false, finish: "stop", text: "whole" }]]);
  attempts = [];
  const { call } = makeHarness();
  const res = await call({ message: "hi", model: "openai/gpt-5.6-terra", max_tokens: 200, temperature: 1 });
  assert.doesNotMatch(res.content[0].text, /TRUNCATED/, res.content[0].text);
  assert.equal(res.structuredContent?.truncated_output, undefined);
});

// ── D5: explicit claude-* on Solana ──
//
// sol.blockrun.ai serves anthropic/claude-* on /v1/chat/completions ($0 probe
// 2026-09-13: 402 "Claude Sonnet 5 API call" / "Claude Opus 5 API call"), and
// mode:"powerful" already sent those ids there. Only the native /v1/messages
// client is EVM-only, and only `thinking` needs it.
test("D5: on Solana an explicit claude-* id without thinking runs on the compat path, paid on Solana", async () => {
  chain = "solana";
  script = new Map([["anthropic/claude-sonnet-5", { settleUsd: 0.0103, fail: false, text: "sonnet on sol" }]]);
  attempts = [];
  const { budget, call } = makeHarness();

  const res = await call({ message: "hi", model: "anthropic/claude-sonnet-5", max_tokens: 1024, temperature: 1 });

  assert.equal(res.isError, undefined, res.content[0].text);
  assert.deepEqual(attempts, ["anthropic/claude-sonnet-5"], "the SolanaLLMClient must carry the call");
  assert.ok(near(budget.spent, 0.0103), `booked the Solana settlement; got ${budget.spent}`);
  assert.match(res.content[0].text, /sonnet on sol/);
});

test("D5: on Solana, claude-* WITH thinking is still refused before anything is sent — thinking needs the native path", async () => {
  chain = "solana";
  script = new Map();
  attempts = [];
  const { budget, call } = makeHarness();

  const res = await call({ message: "hi", model: "anthropic/claude-opus-5", max_tokens: 1024, temperature: 1, thinking: { type: "enabled", budget_tokens: 2048 } });

  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Base-chain payment only/, res.content[0].text);
  assert.match(res.content[0].text, /thinking/, "the refusal names what needs Base");
  assert.deepEqual(attempts, [], "nothing may be sent, let alone paid");
  assert.equal(budget.spent, 0);
});

test("D5: on Base an explicit claude-* id still takes the native /v1/messages path", async () => {
  chain = "base";
  script = new Map();
  attempts = [];
  const { call } = makeHarness();

  // The mock's AnthropicClient factory throws — proof the native branch was
  // taken and the compat client was never asked.
  await assert.rejects(call({ message: "hi", model: "anthropic/claude-sonnet-5", max_tokens: 1024, temperature: 1 }), /native AnthropicClient was built/);
  assert.deepEqual(attempts, []);
});
