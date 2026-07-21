// src/utils/chat-stream.ts
//
// Stream-and-assemble for paid chat completions.
//
// Why: a non-streaming /v1/chat/completions call to a slow reasoning model
// (Kimi K3 with a large prompt takes minutes) moves ZERO bytes between
// "request accepted" and "body ready", so the edge in front of the gateway
// kills the idle connection at ~100s and returns 524 — after the x402 payment
// already settled. Charged, nothing delivered. Streaming keeps tokens flowing
// from the first chunk, so the idle timer never fires; the MCP assembles the
// full text and returns it exactly like the non-streaming path did.
//
// The SDK's fetchWithTimeout clears its abort timer once response HEADERS
// arrive, so reading the body has no client-side deadline — the idle guard
// here (readWithIdleTimeout) is therefore the ONLY thing standing between a
// stalled stream and hanging forever.
import type { ApiClient } from "./wallet.js";

/** Chat message shape the gateway accepts (content may be multimodal parts). */
export interface StreamChatMessage {
  role: "user" | "assistant" | "system";
  content: unknown;
}

export interface StreamChatOptions {
  maxTokens?: number;
  temperature?: number;
  responseFormat?: { type: "text" | "json_object" };
  stop?: string[];
}

/** Narrow an ApiClient to one that can stream (SolanaLLMClient cannot). */
export function supportsStreaming(
  client: ApiClient,
): client is ApiClient & { chatCompletionStream: (model: string, messages: unknown, options?: unknown) => Promise<Response> } {
  return typeof (client as { chatCompletionStream?: unknown }).chatCompletionStream === "function";
}

async function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  ms: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: NodeJS.Timeout | undefined;
  const stall = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`stream stalled: no data from the gateway for ${Math.round(ms / 1000)}s`)),
      ms,
    );
  });
  try {
    return await Promise.race([reader.read(), stall]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Assemble the complete reply from an OpenAI-compatible SSE body.
 *
 * - Concatenates `choices[0].delta.content`; `reasoning_content` is collected
 *   separately and used only as a fallback when no content ever arrives, so a
 *   provider that splits reasoning out doesn't produce an empty answer.
 * - An `error` object mid-stream throws (the gateway reports upstream failures
 *   in-band once headers are already 200).
 * - A JSON parse failure on a single data line skips that line; SSE comment/
 *   keepalive lines (":…") and blank lines are ignored by the data: filter.
 *
 * Exported for tests.
 */
export async function assembleSseChatStream(
  resp: { body: ReadableStream<Uint8Array> | null },
  idleTimeoutMs = 120_000,
): Promise<{ text: string; finishReason: string | null }> {
  if (!resp.body) throw new Error("streaming response had no body");
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let reasoning = "";
  let finishReason: string | null = null;

  const finish = () => ({ text: text || reasoning, finishReason });

  try {
    for (;;) {
      const chunk = await readWithIdleTimeout(reader, idleTimeoutMs);
      if (chunk.done) return finish();
      buffer += decoder.decode(chunk.value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trimEnd(); // tolerates \r\n framing
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") return finish();
        let event: unknown;
        try {
          event = JSON.parse(payload);
        } catch {
          continue; // malformed single line — never abandon the whole stream for it
        }
        const ev = event as {
          error?: { message?: string } | string;
          choices?: Array<{
            delta?: { content?: unknown; reasoning_content?: unknown };
            message?: { content?: unknown };
            finish_reason?: string | null;
          }>;
        };
        if (ev?.error) {
          const msg = typeof ev.error === "string" ? ev.error : ev.error.message ?? JSON.stringify(ev.error);
          throw new Error(`upstream error mid-stream: ${msg}`);
        }
        const choice = ev?.choices?.[0];
        // Some providers put the final text in `message` on the last chunk
        // instead of a delta; treat both, delta first.
        const content = choice?.delta?.content ?? choice?.message?.content;
        if (typeof content === "string") text += content;
        const rc = choice?.delta?.reasoning_content;
        if (typeof rc === "string") reasoning += rc;
        if (choice?.finish_reason) finishReason = choice.finish_reason;
      }
    }
  } catch (err) {
    // Free the connection on any failure path (stall, mid-stream error).
    await reader.cancel().catch(() => undefined);
    throw err;
  }
}

/**
 * Streamed equivalent of `client.chat(...)` / `client.chatCompletion(...)`:
 * returns the assembled reply text. The caller decides WHEN to stream
 * (paid EVM paths); this decides HOW.
 */
export async function streamChatText(
  client: ApiClient & { chatCompletionStream: (model: string, messages: unknown, options?: unknown) => Promise<Response> },
  model: string,
  messages: StreamChatMessage[],
  options: StreamChatOptions,
): Promise<string> {
  const resp = await client.chatCompletionStream(model, messages, options);
  // A provider/route that ignores `stream:true` answers with a plain JSON
  // completion. Feeding that to the SSE parser would "succeed" with an empty
  // string — the silent-truncation failure shape this module must never add.
  const contentType = (resp.headers?.get?.("content-type") ?? "").toLowerCase();
  if (!contentType.includes("text/event-stream")) {
    const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content ?? "";
  }
  const { text, finishReason } = await assembleSseChatStream(resp);
  // Reasoning models stream their hidden thinking as empty-content keepalive
  // chunks, and those tokens COUNT toward max_tokens. A hard task with a small
  // budget can burn the whole budget reasoning and emit zero visible text —
  // finish_reason "length" with an empty answer (measured live: kimi-k3,
  // 4000 max_tokens, 125s of keepalives, 0 chars). Returning "" would be
  // indistinguishable from success; say what happened and what to change.
  if (!text && finishReason === "length") {
    throw new Error(
      `${model} spent the entire max_tokens budget on internal reasoning and produced no visible answer. ` +
      `Raise max_tokens (reasoning tokens count against it) or simplify the request.`,
    );
  }
  return text;
}
