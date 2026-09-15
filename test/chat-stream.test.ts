// Pins the SSE assembly that lets paid chat calls stream instead of holding a
// silent connection open: a slow reasoning model over a non-streaming request
// moves zero bytes until done, the edge 524s the idle connection, and the x402
// payment has already settled — charged, nothing delivered (observed live with
// moonshot/kimi-k3, 2026-07-21). The parser here must (a) assemble exactly the
// text a non-streaming call would have returned and (b) never turn a transport
// or upstream failure into a quiet empty string.
import test from "node:test";
import assert from "node:assert/strict";
import { assembleSseChatStream, supportsStreaming } from "../src/utils/chat-stream.js";
import type { ApiClient } from "../src/utils/wallet.js";

const enc = new TextEncoder();

/** Build a ReadableStream body from raw string chunks (arbitrary boundaries). */
function bodyFrom(chunks: string[], opts?: { hangAfter?: boolean }): { body: ReadableStream<Uint8Array> } {
  let i = 0;
  return {
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i < chunks.length) {
          controller.enqueue(enc.encode(chunks[i++]));
          return;
        }
        if (opts?.hangAfter) return; // never close, never enqueue — a stalled stream
        controller.close();
      },
    }),
  };
}

const chunk = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
const delta = (content: string) => chunk({ choices: [{ delta: { content } }] });

test("assembles deltas across arbitrary chunk boundaries", async () => {
  const full = delta("Hel") + delta("lo ") + delta("world");
  // Split mid-line so JSON and SSE framing straddle chunk boundaries.
  const chunks = [full.slice(0, 17), full.slice(17, 40), full.slice(40)];
  const { text } = await assembleSseChatStream(bodyFrom(chunks));
  assert.equal(text, "Hello world");
});

test("[DONE] terminates and finish_reason is surfaced", async () => {
  const { text, finishReason } = await assembleSseChatStream(bodyFrom([
    delta("hi"),
    chunk({ choices: [{ delta: {}, finish_reason: "stop" }] }),
    "data: [DONE]\n\n",
    delta("IGNORED — after DONE"),
  ]));
  assert.equal(text, "hi");
  assert.equal(finishReason, "stop");
});

test("CRLF framing and keepalive comment lines are tolerated", async () => {
  const { text } = await assembleSseChatStream(bodyFrom([
    ": keep-alive\r\n\r\n",
    `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\r\n\r\n`,
    "data: [DONE]\r\n\r\n",
  ]));
  assert.equal(text, "ok");
});

test("reasoning_content is a fallback, never an addition", async () => {
  // Reasoning + answer: only the answer comes back (matches non-streaming).
  const both = await assembleSseChatStream(bodyFrom([
    chunk({ choices: [{ delta: { reasoning_content: "thinking…" } }] }),
    delta("answer"),
  ]));
  assert.equal(both.text, "answer");
  // Reasoning only: better the reasoning than an empty reply.
  const only = await assembleSseChatStream(bodyFrom([
    chunk({ choices: [{ delta: { reasoning_content: "all I have" } }] }),
  ]));
  assert.equal(only.text, "all I have");
});

test("a final chunk carrying message instead of delta still counts", async () => {
  const { text } = await assembleSseChatStream(bodyFrom([
    chunk({ choices: [{ message: { content: "whole reply" }, finish_reason: "stop" }] }),
  ]));
  assert.equal(text, "whole reply");
});

test("an in-band error event throws instead of returning partial text", async () => {
  await assert.rejects(
    assembleSseChatStream(bodyFrom([
      delta("partial "),
      chunk({ error: { message: "upstream exploded" } }),
    ])),
    /upstream exploded/,
  );
});

test("one malformed data line is skipped, the stream continues", async () => {
  const { text } = await assembleSseChatStream(bodyFrom([
    "data: {not json\n\n",
    delta("survived"),
  ]));
  assert.equal(text, "survived");
});

test("a stalled stream throws the idle-timeout error, not a hang", async () => {
  await assert.rejects(
    assembleSseChatStream(bodyFrom([delta("start")], { hangAfter: true }), 50),
    /stream stalled/,
  );
});

test("a bodyless response throws loudly", async () => {
  await assert.rejects(assembleSseChatStream({ body: null }), /no body/);
});

// The Solana client has no chatCompletionStream (it streams frames through
// stream() instead — see completeChat); the two capability checks are what
// route each client to the right assembler instead of crashing.
test("supportsStreaming / supportsFrameStreaming distinguish the two client shapes", async () => {
  const { supportsFrameStreaming } = await import("../src/utils/chat-stream.js");
  assert.equal(supportsStreaming({ chatCompletionStream: async () => new Response() } as unknown as ApiClient), true);
  assert.equal(supportsStreaming({ chat: async () => "" } as unknown as ApiClient), false);
  assert.equal(supportsFrameStreaming({ stream: async function* () { yield 1; } } as unknown as ApiClient), true);
  assert.equal(supportsFrameStreaming({ chat: async () => "" } as unknown as ApiClient), false);
});

// A reasoning model can burn the whole max_tokens budget thinking and emit
// zero visible text (finish_reason "length", empty content). streamChatText
// must throw a diagnosis, not hand back "" as if the model answered nothing.
test("empty text + finish_reason length throws a max_tokens diagnosis", async () => {
  const { streamChatText } = await import("../src/utils/chat-stream.js");
  const sse = [
    `data: ${JSON.stringify({ choices: [{ delta: { role: "assistant", content: "" } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: "" }, finish_reason: "length" }] })}\n\n`,
    "data: [DONE]\n\n",
  ];
  const fakeClient = {
    chatCompletionStream: async () =>
      new Response(new ReadableStream<Uint8Array>({
        start(c) { for (const s of sse) c.enqueue(enc.encode(s)); c.close(); },
      }), { headers: { "content-type": "text/event-stream" } }),
  };
  await assert.rejects(
    streamChatText(fakeClient as never, "moonshot/kimi-k3", [{ role: "user", content: "hi" }], {}),
    /entire max_tokens budget on internal reasoning/,
  );
});

// ── What the gateway SAYS answered, and how it stopped ──
//
// Every SSE chunk carries `model`, and the last one carries `usage`
// ($0 probes on both gateways, 2026-09-13). The assembler used to read only
// the deltas and finish_reason, so a retired id that the gateway aliased onto
// another model was reported back under the requested name (D55), and a reply
// cut at max_tokens came back looking complete (D57).
test("the served model and the usage chunk are surfaced alongside the text", async () => {
  const { text, finishReason, servedModel, usage } = await assembleSseChatStream(bodyFrom([
    chunk({ model: "nvidia/nemotron-3-super-120b", choices: [{ delta: { content: "hi" } }] }),
    chunk({ model: "nvidia/nemotron-3-super-120b", choices: [{ delta: {}, finish_reason: "length" }] }),
    chunk({ model: "nvidia/nemotron-3-super-120b", choices: [], usage: { prompt_tokens: 74, completion_tokens: 24, total_tokens: 98 } }),
    "data: [DONE]\n\n",
  ]));
  assert.equal(text, "hi");
  assert.equal(finishReason, "length");
  assert.equal(servedModel, "nvidia/nemotron-3-super-120b");
  assert.deepEqual(usage, { promptTokens: 74, completionTokens: 24 });
});

test("a stream with no model or usage fields reports them as null, never as a guess", async () => {
  const { servedModel, usage } = await assembleSseChatStream(bodyFrom([delta("x")]));
  assert.equal(servedModel, null);
  assert.equal(usage, null);
});

test("an in-band error after partial text carries the partial text on the error", async () => {
  const { AcceptedThenFailedError } = await import("../src/utils/chat-stream.js");
  await assert.rejects(
    assembleSseChatStream(bodyFrom([delta("the first 900 tokens"), chunk({ error: { message: "upstream exploded" } })])),
    (err: unknown) => err instanceof AcceptedThenFailedError && err.partialText === "the first 900 tokens",
  );
});

test("the same assembler consumes decoded frames (the Solana client's stream()) with an idle guard", async () => {
  const { assembleChatFrames } = await import("../src/utils/chat-stream.js");
  async function* frames() {
    yield { model: "openai/gpt-5.6-terra", choices: [{ delta: { content: "sol " } }] };
    yield { model: "openai/gpt-5.6-terra", choices: [{ delta: { content: "stream" }, finish_reason: "stop" }] };
    yield { choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } };
  }
  const out = await assembleChatFrames(frames());
  assert.equal(out.text, "sol stream");
  assert.equal(out.servedModel, "openai/gpt-5.6-terra");
  assert.equal(out.finishReason, "stop");
  assert.deepEqual(out.usage, { promptTokens: 3, completionTokens: 2 });

  async function* stalls() {
    yield { choices: [{ delta: { content: "start" } }] };
    await new Promise(() => undefined); // never yields again
  }
  await assert.rejects(assembleChatFrames(stalls(), 50), /stream stalled/);
});

test("streamChatText reads x-blockrun-cost-usd off the response when the rail sends it", async () => {
  const { streamChatText } = await import("../src/utils/chat-stream.js");
  const body = (frames: string[]) => new ReadableStream<Uint8Array>({ start(c) { for (const s of frames) c.enqueue(enc.encode(s)); c.close(); } });
  const mk = (headers: Record<string, string>) => ({
    chatCompletionStream: async () => new Response(body([delta("ok"), "data: [DONE]\n\n"]), { headers: { "content-type": "text/event-stream", ...headers } }),
  });
  const withHeader = await streamChatText(mk({ "x-blockrun-cost-usd": "0.000000" }) as never, "m", [{ role: "user", content: "hi" }], {});
  assert.equal(withHeader.settledUsd, 0, "an explicit zero is a settled zero");
  const without = await streamChatText(mk({}) as never, "m", [{ role: "user", content: "hi" }], {});
  assert.equal(without.settledUsd, null, "absent means unknown, not free");
  const priced = await streamChatText(mk({ "x-blockrun-cost-usd": "0.003100" }) as never, "m", [{ role: "user", content: "hi" }], {});
  assert.equal(priced.settledUsd, 0.0031);
});

// ── completeChat over the Solana client's stream(): where the payment is ──
//
// openPaidStream pays, records the settlement, and only then hands out frames.
// A stall BEFORE the first frame cannot be placed by this module (the paid
// request may still be in flight); it must NOT read as "accepted" — the
// classifier treats a plain timeout as "unknown" and books the reserve. A
// stall AFTER the first frame is post-acceptance.
test("completeChat on a frame-streaming client: a first-frame stall is a timeout, a later stall is post-acceptance", async () => {
  const { completeChat, AcceptedThenFailedError } = await import("../src/utils/chat-stream.js");
  const never = () => new Promise<never>(() => undefined);
  const beforeFirst = { getSpending: () => ({ totalUsd: 0 }), chatCompletion: async () => ({}), stream: async function* () { await never(); yield {}; } };
  await assert.rejects(
    completeChat(beforeFirst as never, "m", [{ role: "user", content: "hi" }], {}, { stream: true, idleTimeoutMs: 30 }),
    (err: unknown) => err instanceof Error && !(err instanceof AcceptedThenFailedError) && /timeout/.test(err.message),
  );
  const afterFirst = { getSpending: () => ({ totalUsd: 0 }), chatCompletion: async () => ({}), stream: async function* () { yield { choices: [{ delta: { content: "a" } }] }; await never(); } };
  await assert.rejects(
    completeChat(afterFirst as never, "m", [{ role: "user", content: "hi" }], {}, { stream: true, idleTimeoutMs: 30 }),
    (err: unknown) => err instanceof AcceptedThenFailedError && /stalled/.test(err.message),
  );
  // The SDK's own throw from the first next() (unpaid 4xx, refused payment,
  // abort) passes through untouched.
  const refused = { getSpending: () => ({ totalUsd: 0 }), chatCompletion: async () => ({}), stream: async function* () { throw Object.assign(new Error("API error: 400"), { name: "APIError", statusCode: 400 }); yield {}; } };
  await assert.rejects(
    completeChat(refused as never, "m", [{ role: "user", content: "hi" }], {}, { stream: true, idleTimeoutMs: 30 }),
    (err: unknown) => (err as { name?: string }).name === "APIError" && !(err instanceof AcceptedThenFailedError),
  );
  // And the body the SDK builds carries stream:true with the caller's options.
  let sent: Record<string, unknown> | undefined;
  const ok = { getSpending: () => ({ totalUsd: 0 }), chatCompletion: async () => ({}), stream: async function* (_p: string, body: Record<string, unknown>) { sent = body; yield { model: "m", choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }; } };
  const out = await completeChat(ok as never, "m", [{ role: "user", content: "hi" }], { maxTokens: 77, temperature: 0.2, stop: ["x"] }, { stream: true });
  assert.equal(out.text, "done");
  assert.deepEqual(sent, { model: "m", messages: [{ role: "user", content: "hi" }], max_tokens: 77, stream: true, temperature: 0.2, stop: ["x"] });
});

// ── settlementOnThrow: the money verdict, rail by rail ──
test("settlementOnThrow: the wallet rail reads the SDK's after-payment prefix and the status", async () => {
  const { settlementOnThrow } = await import("../src/utils/chat-stream.js");
  const api = (m: string, statusCode: number) => Object.assign(new Error(m), { name: "APIError", statusCode });
  const w = (e: unknown) => settlementOnThrow(e, { rail: "wallet", estimateUsd: 0.01 });
  assert.equal(w(api("API error: 400", 400)), "none");
  assert.equal(w(api("API error: 503", 503)), "none", "an unpaid first response, whatever the status");
  assert.equal(w(api("API error after payment: 400", 400)), "none", "the gateway's own refusal on the paid retry");
  assert.equal(w(api("API error after payment: 429", 429)), "none");
  assert.equal(w(api("API error after payment: 524", 524)), "unknown");
  assert.equal(w(api("API error after payment: 502", 502)), "unknown");
  assert.equal(w(api("API error after payment: 500", 500)), "unknown");
  assert.equal(w(Object.assign(new Error("Payment was rejected. Check your wallet balance."), { name: "PaymentError" })), "none");
  assert.equal(w(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })), "unknown");
  assert.equal(w(Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } })), "none", "never connected");
  assert.equal(w(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } })), "unknown", "died in flight");
  assert.equal(w(new Error("maxTokens must be an integer")), "none", "never left the process");
  assert.equal(w(api("API error after payment: 524", 524)), "unknown");
  assert.equal(settlementOnThrow(api("API error after payment: 524", 524), { rail: "wallet", estimateUsd: 0 }), "none", "a free model cannot have cost anything");
});

test("settlementOnThrow: the account rail bills nothing for a labelled refusal, and only an unanswered origin is ambiguous", async () => {
  const { settlementOnThrow, AcceptedThenFailedError } = await import("../src/utils/chat-stream.js");
  const api = (statusCode: number) => Object.assign(new Error(`BlockRun account API error: ${statusCode}.`), { name: "APIError", statusCode });
  const a = (e: unknown) => settlementOnThrow(e, { rail: "account", estimateUsd: 0.01 });
  for (const s of [400, 401, 402, 404, 413, 422, 429, 500, 503]) assert.equal(a(api(s)), "none", `status ${s}`);
  for (const s of [408, 502, 504, 522, 524]) assert.equal(a(api(s)), "unknown", `status ${s}`);
  assert.equal(a(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })), "unknown");
  assert.equal(a(new AcceptedThenFailedError("upstream error mid-stream: x")), "settled");
});

test("settlementOnThrow: the native path (payment inside fetch) judges the status alone", async () => {
  const { settlementOnThrow } = await import("../src/utils/chat-stream.js");
  const sdk = (status: number | undefined, message: string, cause?: Error) => Object.assign(new Error(message), { status, cause });
  const n = (e: unknown) => settlementOnThrow(e, { rail: "wallet", estimateUsd: 0.01, transparentPayment: true });
  assert.equal(n(sdk(400, "400 invalid_request_error")), "none");
  assert.equal(n(sdk(429, "429 rate limited")), "none");
  assert.equal(n(sdk(524, "524 status code (no body)")), "unknown");
  assert.equal(n(sdk(500, "500 internal")), "unknown");
  assert.equal(n(sdk(undefined, "Connection error.", new Error("Payment was rejected. Check your wallet balance."))), "none");
  assert.equal(n(sdk(undefined, "Request timed out.")), "unknown");
});
