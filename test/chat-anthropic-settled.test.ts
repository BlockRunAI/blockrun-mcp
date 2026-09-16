// Run with: npm test  (tsx --experimental-test-module-mocks --test)
//
// The native claude-* path (chat-anthropic.ts) and money.
//
// Until audit round 3 (C20) handleAnthropicNative caught every error from the
// SDK and returned formatError with no booking and no note — the settled-then-
// failed machinery 0.40.1/0.49.0/0.50.0 wired into the three OpenAI-compat
// paths never reached this one. Worse, on the wallet rail @blockrun/llm builds
// the official SDK at its default maxRetries=2 with a fetch that signs a FRESH
// x402 payment on every 402 it sees, so a 5xx/524/timeout after settlement was
// retried up to twice more — three settlements for one undelivered answer, none
// in the ledger, and text that said "try again".
//
// Two more findings ride on the same call: D51 — a non-streaming request with
// max_tokens above 21,333 (every thinking budget >= 20,310) never left the
// process, because @anthropic-ai/sdk refuses it ("Streaming is required…") —
// and D58, the $0.001 tx fee the ledger added on the account rail, which
// charges none.
//
// The client here is a fake MessageStream; the last test uses the REAL SDK
// against a canned fetch to prove the streaming route sidesteps the guard.
import { test } from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { handleAnthropicNative, anthropicCallCost } from "../src/tools/chat-anthropic.js";
import type { BudgetState } from "../src/types.js";

// Wallet rail throughout: no BLOCKRUN_API_KEY. The account-rail twin of these
// cases lives in chat-anthropic-account.test.ts (mode is fixed per process).
delete process.env.BLOCKRUN_API_KEY;

function newBudget(): BudgetState {
  return { limit: 100, spent: 0, calls: 0, agents: new Map() };
}

function message(over: Partial<Anthropic.Message> = {}): Anthropic.Message {
  return {
    id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-4-5-20251001",
    content: [{ type: "text", text: "hello", citations: null }],
    stop_reason: "end_turn", stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: null, cache_read_input_tokens: null, server_tool_use: null, service_tier: null },
    ...over,
  } as Anthropic.Message;
}

type FakeScript = { connect: boolean; events?: number; result: Anthropic.Message | Error };
let lastOptions: Record<string, unknown> | undefined;
let lastParams: Record<string, unknown> | undefined;

// A stand-in for the SDK's MessageStream: `connect` fires once the 2xx is in,
// `streamEvent` per frame, and finalMessage() resolves or rejects.
function fakeClient(s: FakeScript) {
  return {
    messages: {
      create: async () => { throw new Error("the native path must stream — create() must not be called"); },
      stream: (params: Record<string, unknown>, options?: Record<string, unknown>) => {
        lastParams = params;
        lastOptions = options;
        const listeners: Record<string, Array<(...a: unknown[]) => void>> = {};
        const self = {
          on(ev: string, cb: (...a: unknown[]) => void) { (listeners[ev] ??= []).push(cb); return self; },
          off() { return self; },
          abort() {},
          response: null,
          finalMessage: async () => {
            await Promise.resolve();
            if (s.connect) for (const cb of listeners.connect ?? []) cb();
            for (let i = 0; i < (s.events ?? 0); i++) for (const cb of listeners.streamEvent ?? []) cb({ type: "content_block_delta" });
            if (s.result instanceof Error) throw s.result;
            return s.result;
          },
        };
        return self;
      },
    },
  };
}

function sdkError(status: number | undefined, msg: string, cause?: Error): Error {
  return Object.assign(new Error(msg), { status, cause });
}

const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
const baseArgs = { model: "anthropic/claude-haiku-4.5", message: "hi", maxTokens: 1024, estimatedCost: 0.05 };

test("the native call is streamed with maxRetries: 0 — one payment, never re-signed by the SDK's retry loop", async () => {
  const client = fakeClient({ connect: true, events: 3, result: message() });
  const res = await handleAnthropicNative({ client: client as never, ...baseArgs, budget: newBudget() });
  assert.equal(res.isError, undefined, res.content[0].text);
  assert.equal(lastOptions?.maxRetries, 0, "the SDK must not retry (each retry pays a fresh 402)");
  assert.equal(lastParams?.model, "anthropic/claude-haiku-4.5");
});

test("a 4xx before any stream connected books nothing and carries no charge note", async () => {
  const budget = newBudget();
  const client = fakeClient({ connect: false, result: sdkError(400, "400 max_tokens: invalid") });
  const res = await handleAnthropicNative({ client: client as never, ...baseArgs, budget });
  assert.equal(res.isError, true);
  assert.equal(budget.spent, 0, `booked ${budget.spent}`);
  assert.doesNotMatch(res.content[0].text, /charge stands|may have|billed/i, res.content[0].text);
});

test("a payment the wallet could not make is not money", async () => {
  const budget = newBudget();
  const client = fakeClient({ connect: false, result: sdkError(undefined, "Connection error.", new Error("Payment was rejected. Check your wallet balance.")) });
  const res = await handleAnthropicNative({ client: client as never, ...baseArgs, budget });
  assert.equal(res.isError, true);
  assert.equal(budget.spent, 0);
  assert.doesNotMatch(res.content[0].text, /charge stands|may have settled/i, res.content[0].text);
});

test("a 5xx/524 with no stream connected MAY have settled — booked at the reconstructed quote, said so, no retry advice", async () => {
  const budget = newBudget();
  const client = fakeClient({ connect: false, result: sdkError(524, "524 status code (no body)") });
  const res = await handleAnthropicNative({ client: client as never, ...baseArgs, budget });
  assert.equal(res.isError, true);
  const expected = anthropicCallCost("anthropic/claude-haiku-4.5", 2, 1024)!;
  assert.ok(near(budget.spent, expected), `booked ${budget.spent}, expected the quote ${expected}`);
  assert.match(res.content[0].text, /may have (settled|been billed)|cannot tell whether/i, res.content[0].text);
  assert.match(res.content[0].text, /second charge/i, res.content[0].text);
  assert.doesNotMatch(res.content[0].text, /needs funding/, res.content[0].text);
});

test("a failure AFTER the stream connected is a settled call — booked, and said plainly", async () => {
  const budget = newBudget();
  const client = fakeClient({ connect: true, events: 2, result: sdkError(undefined, "Connection error.", new Error("terminated")) });
  const res = await handleAnthropicNative({ client: client as never, ...baseArgs, budget });
  assert.equal(res.isError, true);
  assert.ok(budget.spent > 0, `booked ${budget.spent}`);
  assert.match(res.content[0].text, /charge stands/, res.content[0].text);
  assert.match(res.content[0].text, /second charge/i, res.content[0].text);
});

test("a thinking budget above the SDK's non-streaming ceiling is sent, not refused in-process (D51)", async () => {
  const client = fakeClient({ connect: true, events: 1, result: message() });
  const res = await handleAnthropicNative({
    client: client as never, ...baseArgs, model: "anthropic/claude-opus-5", thinking: { type: "enabled", budget_tokens: 32_000 }, budget: newBudget(),
  });
  assert.equal(res.isError, undefined, res.content[0].text);
  assert.equal(lastParams?.max_tokens, 33_024, "max_tokens auto-raised above the budget");
});

test("wallet rail: success books the reconstructed quote, fee included", async () => {
  const budget = newBudget();
  const client = fakeClient({ connect: true, events: 2, result: message() });
  const res = await handleAnthropicNative({ client: client as never, ...baseArgs, budget });
  assert.equal(res.isError, undefined, res.content[0].text);
  assert.ok(near(budget.spent, anthropicCallCost("claude-haiku-4-5-20251001", 2, 1024)!), `booked ${budget.spent}`);
  // The wallet quote formula still carries the observed fee and the floor.
  assert.equal(anthropicCallCost("claude-haiku-4-5-20251001", 2, 1024), 0.002);
});

// The real SDK, no network: the fetch stub answers /v1/messages with a canned
// SSE message. `create()` with max_tokens 33,024 must refuse before fetch
// (that is the D51 failure); `stream()` must go through and assemble it.
test("real @anthropic-ai/sdk: create() refuses 33k max_tokens non-streaming, stream() carries it (D51)", async () => {
  let fetches = 0;
  const enc = new TextEncoder();
  const sse = [
    { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "let me think" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig123" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "42" } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 7 } },
    { type: "message_stop" },
  ].map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  const fetchStub = async () => {
    fetches += 1;
    return new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode(sse)); c.close(); } }), {
      status: 200, headers: { "content-type": "text/event-stream" },
    });
  };
  const client = new Anthropic({ apiKey: "blockrun", baseURL: "https://gateway.invalid/api", fetch: fetchStub as unknown as typeof fetch, maxRetries: 0 });
  const params = { model: "claude-opus-5", max_tokens: 33_024, messages: [{ role: "user" as const, content: "hi" }], thinking: { type: "enabled" as const, budget_tokens: 32_000 } };

  // The guard fires synchronously, before the request is even built.
  assert.throws(() => client.messages.create(params), /Streaming is required/);
  assert.equal(fetches, 0, "the non-streaming refusal happens before any request");

  const final = await client.messages.stream(params, { maxRetries: 0 }).finalMessage();
  assert.equal(fetches, 1);
  assert.equal(final.stop_reason, "end_turn");
  const thinking = final.content.find((b) => b.type === "thinking") as Anthropic.ThinkingBlock | undefined;
  assert.equal(thinking?.thinking, "let me think");
  assert.equal(thinking?.signature, "sig123", "the signature survives streaming assembly");
  assert.equal((final.content.find((b) => b.type === "text") as Anthropic.TextBlock).text, "42");
});

// Round 4b (CH-1): the Anthropic SDK wraps a never-connected fetch TWO levels
// deep — APIConnectionError("Connection error.") → cause TypeError("fetch
// failed") → cause { code: "ENOTFOUND" } — and the classifier read cause.code
// one level down, found nothing, and the "fetch failed" text tripped the
// transport regex: a DNS failure booked the reconstructed quote and forbade a
// retry, for a request that never left the machine. The compat path saw the
// raw undici error and said "none". Rail parity, in the direction that
// over-books.
test("a never-connected fetch nested two causes deep (the Anthropic SDK's shape) books nothing", async () => {
  for (const code of ["ENOTFOUND", "ECONNREFUSED", "EAI_AGAIN"]) {
    const budget = newBudget();
    const undici = Object.assign(new TypeError("fetch failed"), { cause: { code } });
    const client = fakeClient({ connect: false, result: sdkError(undefined, "Connection error.", undici) });
    const res = await handleAnthropicNative({ client: client as never, ...baseArgs, budget });
    assert.equal(res.isError, true);
    assert.equal(budget.spent, 0, `${code}: booked ${budget.spent}`);
    assert.doesNotMatch(res.content[0].text, /may have|second charge|charge stands/i, `${code}: ${res.content[0].text}`);
  }
});

// Round 4b (CH-3): an idle stall BEFORE the stream connected is not a settled
// call. The 2xx never arrived, so the SDK's counter recorded nothing; the
// payment may have been sent (Base: the paid retry runs long) — a maybe, the
// same verdict the compat Solana path gives its own "before the first frame"
// stall — not "the charge stands".
test("an idle stall before the stream connects is a MAYBE, not a settled charge", async () => {
  const budget = newBudget();
  const client = {
    messages: {
      create: async () => { throw new Error("must stream"); },
      stream: () => {
        const self = { on() { return self; }, off() { return self; }, abort() {}, response: null, finalMessage: () => new Promise(() => {}) };
        return self;
      },
    },
  };
  const { handleAnthropicNative: h } = await import("../src/tools/chat-anthropic.js");
  const res = await h({ client: client as never, ...baseArgs, budget, idleTimeoutMs: 20 } as never);
  assert.equal(res.isError, true);
  assert.ok(budget.spent > 0, "the payment may have gone out — booked as a precaution");
  assert.match(res.content[0].text, /cannot tell whether|MAY have been billed/i, res.content[0].text);
  assert.doesNotMatch(res.content[0].text, /charge stands/, res.content[0].text);
});

// Round 4b (CH-5): the compat assembler hands back the partial text that
// streamed before a post-acceptance failure (the caller paid for those
// tokens); the native path discarded it.
test("partial text streamed before a post-acceptance failure rides along on the native path", async () => {
  const budget = newBudget();
  const client = {
    messages: {
      create: async () => { throw new Error("must stream"); },
      stream: () => {
        const listeners: Record<string, Array<(...a: unknown[]) => void>> = {};
        const self = {
          on(ev: string, cb: (...a: unknown[]) => void) { (listeners[ev] ??= []).push(cb); return self; },
          off() { return self; }, abort() {}, response: null,
          finalMessage: async () => {
            await Promise.resolve();
            for (const cb of listeners.connect ?? []) cb();
            for (const cb of listeners.text ?? []) cb("The first half of the ans", "The first half of the ans");
            for (const cb of listeners.streamEvent ?? []) cb({ type: "content_block_delta" });
            throw Object.assign(new Error("Connection error."), { cause: new Error("terminated") });
          },
        };
        return self;
      },
    },
  };
  const res = await handleAnthropicNative({ client: client as never, ...baseArgs, budget });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /charge stands/);
  assert.match(res.content[0].text, /Partial response received before the failure/);
  assert.match(res.content[0].text, /The first half of the ans/);
  assert.equal((res.structuredContent as { partial_response?: string } | undefined)?.partial_response, "The first half of the ans");
});
