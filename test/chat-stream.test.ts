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

// The Solana client has no chatCompletionStream — the capability check is what
// keeps those callers on the old non-streaming path instead of crashing.
test("supportsStreaming distinguishes streaming-capable clients", () => {
  assert.equal(supportsStreaming({ chatCompletionStream: async () => new Response() } as unknown as ApiClient), true);
  assert.equal(supportsStreaming({ chat: async () => "" } as unknown as ApiClient), false);
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
