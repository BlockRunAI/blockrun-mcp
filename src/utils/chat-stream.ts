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
// here (withIdleTimeout, around every read) is therefore the ONLY thing
// standing between a stalled stream and hanging forever.
//
// Two clients, one assembler. LLMClient (Base wallet, and the account rail)
// exposes chatCompletionStream() and hands back the raw Response — headers
// included, which is where the account rail's `x-blockrun-cost-usd` lives.
// SolanaLLMClient has no chatCompletionStream, but since @blockrun/llm 3.15.1
// it ships stream(path, body), which pays the 402, records the settlement, and
// yields each decoded SSE frame. Until audit round 3 the comment here said the
// Solana client "cannot" stream, and every paid chat on the DEFAULT chain ran
// the non-streaming path with the SDK's 60s Solana timeout — so a generation
// over a minute was aborted client-side after the SPL payment was sent (C19).
// Both shapes now feed the same accumulator (assembleChatFrames).
import type { ApiClient } from "./wallet.js";
import { parseCostHeader } from "./api-key-call.js";

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

/** Token counts the gateway reports for the call, when it does. */
export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
}

/**
 * Everything a chat call comes back with that the caller has to act on — not
 * just the text. `servedModel` is the id the GATEWAY says answered; constants.ts
 * documents that retired ids are silently aliased onto a live model and that
 * only this field tells you (D55). `finishReason` "length" means the reply was
 * cut at max_tokens (D57). `settledUsd` is `x-blockrun-cost-usd` when the rail
 * sent it — a settled zero included — and null when it did not.
 */
export interface ChatOutcome {
  text: string;
  servedModel: string | null;
  finishReason: string | null;
  usage: ChatUsage | null;
  settledUsd: number | null;
}

/**
 * A failure that arrived AFTER the gateway had answered 2xx: a mid-stream error
 * event, an idle stall, an empty-length completion, an unreadable body. The
 * distinction is money. On the wallet rails x402 settles on the 200, and on the
 * account rail the request is billed once accepted — so this class is the
 * evidence a caller needs to book the charge, where a pre-acceptance throw
 * (a 4xx from the first response, a refused payment) books nothing.
 *
 * `partialText` is whatever had streamed before the failure. The caller paid
 * for those tokens; discarding them turned "900 tokens then an error frame"
 * into a bare error (D57).
 */
export class AcceptedThenFailedError extends Error {
  readonly partialText: string;
  constructor(message: string, partialText = "", options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AcceptedThenFailedError";
    this.partialText = partialText;
  }
}

type StreamingClient = ApiClient & { chatCompletionStream: (model: string, messages: unknown, options?: unknown) => Promise<Response> };
type FrameStreamingClient = ApiClient & { stream: (path: string, body: Record<string, unknown>) => AsyncGenerator<unknown, void, undefined> };

/** Narrow an ApiClient to one whose stream call returns the raw Response (LLMClient). */
export function supportsStreaming(client: ApiClient): client is StreamingClient {
  return typeof (client as { chatCompletionStream?: unknown }).chatCompletionStream === "function";
}

/** Narrow an ApiClient to one whose stream call yields decoded frames (SolanaLLMClient). */
export function supportsFrameStreaming(client: ApiClient): client is FrameStreamingClient {
  return typeof (client as { stream?: unknown }).stream === "function";
}

/**
 * The account rail's settled figure off a response, when it sent one. Absent
 * is "unknown" (chat settles after the response by design), never "free"; an
 * explicit 0.000000 is a settled zero. parseCostHeader draws that line.
 */
export function settledCostFromHeaders(headers: { get(name: string): string | null } | null | undefined): number | null {
  return parseCostHeader(headers?.get("x-blockrun-cost-usd"));
}

function stallError(ms: number): AcceptedThenFailedError {
  return new AcceptedThenFailedError(`stream stalled: no data from the gateway for ${Math.round(ms / 1000)}s`);
}

async function withIdleTimeout<T>(read: () => Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const stall = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(stallError(ms)), ms);
  });
  try {
    return await Promise.race([read(), stall]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One decoded OpenAI-compatible chunk folded into the running result.
 *
 * - Concatenates `choices[0].delta.content`; `reasoning_content` is collected
 *   separately and used only as a fallback when no content ever arrives, so a
 *   provider that splits reasoning out doesn't produce an empty answer.
 * - An `error` object mid-stream throws (the gateway reports upstream failures
 *   in-band once headers are already 200) — with the partial text attached.
 * - `model` is taken from any chunk that carries it (every chunk does, on both
 *   gateways); `usage` from the final choices-less chunk.
 */
class ChatAccumulator {
  text = "";
  reasoning = "";
  finishReason: string | null = null;
  servedModel: string | null = null;
  usage: ChatUsage | null = null;

  fold(event: unknown): void {
    const ev = event as {
      error?: { message?: string } | string;
      model?: unknown;
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
      choices?: Array<{
        delta?: { content?: unknown; reasoning_content?: unknown };
        message?: { content?: unknown };
        finish_reason?: string | null;
      }>;
    };
    if (ev?.error) {
      const msg = typeof ev.error === "string" ? ev.error : ev.error.message ?? JSON.stringify(ev.error);
      throw new AcceptedThenFailedError(`upstream error mid-stream: ${msg}`, this.result().text);
    }
    if (typeof ev?.model === "string" && ev.model) this.servedModel = ev.model;
    const u = ev?.usage;
    if (u && typeof u.prompt_tokens === "number" && typeof u.completion_tokens === "number") {
      this.usage = { promptTokens: u.prompt_tokens, completionTokens: u.completion_tokens };
    }
    const choice = ev?.choices?.[0];
    // Some providers put the final text in `message` on the last chunk
    // instead of a delta; treat both, delta first.
    const content = choice?.delta?.content ?? choice?.message?.content;
    if (typeof content === "string") this.text += content;
    const rc = choice?.delta?.reasoning_content;
    if (typeof rc === "string") this.reasoning += rc;
    if (choice?.finish_reason) this.finishReason = choice.finish_reason;
  }

  result(): Omit<ChatOutcome, "settledUsd"> {
    return { text: this.text || this.reasoning, finishReason: this.finishReason, servedModel: this.servedModel, usage: this.usage };
  }
}

/**
 * Assemble the complete reply from an OpenAI-compatible SSE body.
 *
 * A JSON parse failure on a single data line skips that line; SSE comment/
 * keepalive lines (":…") and blank lines are ignored by the data: filter.
 *
 * Exported for tests.
 */
export async function assembleSseChatStream(
  resp: { body: ReadableStream<Uint8Array> | null },
  idleTimeoutMs = 120_000,
): Promise<Omit<ChatOutcome, "settledUsd">> {
  if (!resp.body) throw new AcceptedThenFailedError("streaming response had no body");
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  const acc = new ChatAccumulator();
  let buffer = "";

  try {
    for (;;) {
      const chunk = await withIdleTimeout(() => reader.read(), idleTimeoutMs);
      if (chunk.done) return acc.result();
      buffer += decoder.decode(chunk.value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trimEnd(); // tolerates \r\n framing
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") return acc.result();
        let event: unknown;
        try {
          event = JSON.parse(payload);
        } catch {
          continue; // malformed single line — never abandon the whole stream for it
        }
        acc.fold(event);
      }
    }
  } catch (err) {
    // Free the connection on any failure path (stall, mid-stream error).
    await reader.cancel().catch(() => undefined);
    throw err;
  }
}

/**
 * The same assembly over already-decoded frames — what SolanaLLMClient.stream()
 * yields. The SDK's generator has no idle guard of its own (its fetch deadline
 * ends at the headers, like LLMClient's), so the stall timer wraps each next().
 *
 * Exported for tests.
 */
export async function assembleChatFrames(
  frames: AsyncIterator<unknown> | AsyncIterable<unknown>,
  idleTimeoutMs = 120_000,
  acc = new ChatAccumulator(),
): Promise<Omit<ChatOutcome, "settledUsd">> {
  const it: AsyncIterator<unknown> = Symbol.asyncIterator in (frames as object)
    ? (frames as AsyncIterable<unknown>)[Symbol.asyncIterator]()
    : (frames as AsyncIterator<unknown>);
  try {
    for (;;) {
      const next = await withIdleTimeout(() => it.next(), idleTimeoutMs);
      if (next.done) return acc.result();
      acc.fold(next.value);
    }
  } catch (err) {
    // Ask the generator to finish so the SDK releases its reader lock. NOT
    // awaited: a generator suspended inside `await reader.read()` (the stall
    // case) only honours return() once that read resolves, which is never —
    // awaiting it here would turn the stall guard back into a hang.
    void it.return?.(undefined).catch(() => undefined);
    throw err;
  }
}

/**
 * Reasoning models stream their hidden thinking as empty-content keepalive
 * chunks, and those tokens COUNT toward max_tokens. A hard task with a small
 * budget can burn the whole budget reasoning and emit zero visible text —
 * finish_reason "length" with an empty answer (measured live: kimi-k3,
 * 4000 max_tokens, 125s of keepalives, 0 chars). Returning "" would be
 * indistinguishable from success; say what happened and what to change.
 */
function rejectEmptyLength(model: string, out: Omit<ChatOutcome, "settledUsd">): void {
  if (!out.text && out.finishReason === "length") {
    throw new AcceptedThenFailedError(
      `${model} spent the entire max_tokens budget on internal reasoning and produced no visible answer. ` +
      `Raise max_tokens (reasoning tokens count against it) or simplify the request.`,
    );
  }
}

/**
 * Anything thrown once a 2xx is in hand is a post-acceptance failure, whatever
 * its type: a body-read error, a JSON parse error on a non-SSE answer, the
 * assembler's own throws. Wrap it so the caller can tell it from a refusal.
 */
async function afterAccept<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof AcceptedThenFailedError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new AcceptedThenFailedError(msg, "", { cause: err });
  }
}

/**
 * Streamed equivalent of `client.chat(...)` / `client.chatCompletion(...)` over
 * LLMClient: returns the assembled reply plus what the gateway said about it.
 * The caller decides WHEN to stream; this decides HOW.
 */
export async function streamChatText(
  client: StreamingClient,
  model: string,
  messages: StreamChatMessage[],
  options: StreamChatOptions,
  idleTimeoutMs?: number,
): Promise<ChatOutcome> {
  // The SDK throws on any non-OK response before returning, so a Response here
  // IS the acceptance — money has moved (wallet) or will be billed (account).
  const resp = await client.chatCompletionStream(model, messages, options);
  const settledUsd = settledCostFromHeaders(resp.headers);
  return afterAccept(async () => {
    // A provider/route that ignores `stream:true` answers with a plain JSON
    // completion. Feeding that to the SSE parser would "succeed" with an empty
    // string — the silent-truncation failure shape this module must never add.
    const contentType = (resp.headers?.get?.("content-type") ?? "").toLowerCase();
    if (!contentType.includes("text/event-stream")) {
      const data = await resp.json();
      const acc = new ChatAccumulator();
      acc.fold(data);
      const out = acc.result();
      rejectEmptyLength(model, out);
      return { ...out, settledUsd };
    }
    const out = await assembleSseChatStream(resp, idleTimeoutMs);
    rejectEmptyLength(model, out);
    return { ...out, settledUsd };
  });
}

/**
 * One chat call, whichever client this is, as a ChatOutcome.
 *
 * - LLMClient (Base wallet, account rail): chatCompletionStream when `stream`.
 * - SolanaLLMClient: stream("/v1/chat/completions", { …, stream: true }) when
 *   `stream` — settlement is recorded before the first frame, so the idle guard
 *   and the post-acceptance class apply exactly as on Base.
 * - Otherwise, or when `stream` is false (the free tier, whose short per-model
 *   timeout the deadline loop depends on): the non-streaming chatCompletion,
 *   whose parsed body still carries `model`, `finish_reason` and `usage`.
 */
export async function completeChat(
  client: ApiClient,
  model: string,
  messages: StreamChatMessage[],
  options: StreamChatOptions,
  opts: { stream: boolean; idleTimeoutMs?: number },
): Promise<ChatOutcome> {
  if (opts.stream && supportsStreaming(client)) {
    return streamChatText(client, model, messages, options, opts.idleTimeoutMs);
  }
  if (opts.stream && supportsFrameStreaming(client)) {
    // The SDK does not inject stream:true ("silently rewriting a caller's body
    // is how you end up debugging a request you did not send"); the body is
    // the same shape LLMClient.chatCompletionStream builds.
    const body: Record<string, unknown> = { model, messages, max_tokens: options.maxTokens ?? 1024, stream: true };
    if (options.temperature !== undefined) body.temperature = options.temperature;
    if (options.responseFormat !== undefined) body.response_format = options.responseFormat;
    if (options.stop !== undefined) body.stop = options.stop;
    const gen = client.stream("/v1/chat/completions", body);
    // openPaidStream pays and records the settlement before the first frame is
    // handed out, so the very first next() is where a pre-acceptance throw
    // (unpaid 4xx, refused payment, the SDK's abort on the paid retry) surfaces
    // — outside afterAccept, unwrapped, for settlementOnThrow to read. A STALL
    // waiting for that first frame is the one case this module cannot place:
    // the paid request may still be in flight (payment sent, no verdict) or
    // the 200 may be in and the upstream silent. Either way the counter says
    // what was recorded, so it is rethrown as a plain timeout — "unknown" to
    // the classifier, which books the reserve — rather than as accepted.
    const first = await withIdleTimeout(() => gen.next(), opts.idleTimeoutMs ?? 120_000).catch((err: unknown) => {
      if (err instanceof AcceptedThenFailedError) throw new Error(`timeout: ${err.message}, before the first frame`, { cause: err });
      throw err;
    });
    return afterAccept(async () => {
      const acc = new ChatAccumulator();
      if (!first.done) acc.fold(first.value);
      const out = first.done ? acc.result() : await assembleChatFrames(gen, opts.idleTimeoutMs, acc);
      rejectEmptyLength(model, out);
      return { ...out, settledUsd: null };
    });
  }
  const r = await client.chatCompletion(model, messages as unknown as Parameters<ApiClient["chatCompletion"]>[1], options);
  return afterAccept(async () => {
    const acc = new ChatAccumulator();
    acc.fold(r);
    const out = acc.result();
    rejectEmptyLength(model, out);
    return { ...out, settledUsd: null };
  });
}

// ---------------------------------------------------------------------------
// Did money move? — classifying a chat call that THREW
// ---------------------------------------------------------------------------

/**
 * "none":    nothing was accepted, so nothing was charged — book $0, and a
 *            fallback loop may go on to the next model.
 * "unknown": a payment was signed and sent (wallet) or the request reached
 *            the gateway (account) and no verdict came back — a timeout on the
 *            paid retry, an edge 502/504/52x, a reset mid-flight. The gateway
 *            settles those after the client has given up. Book the reserve as a
 *            precaution and never pay a second model for the same call.
 * "settled": the gateway answered 2xx and the failure came after — the charge
 *            is certain (AcceptedThenFailedError).
 */
export type SettlementVerdict = "none" | "unknown" | "settled";

// Statuses an edge or a load balancer returns when the ORIGIN did not answer in
// time — the origin may still be running the request and settle it afterwards
// (the Cloud Run route documents that a client disconnect is never propagated
// to a non-streaming handler). Everything else in the 4xx/5xx range is the
// gateway itself answering, which it does before settlement starts.
const ORIGIN_DID_NOT_ANSWER = new Set([408, 502, 504, 520, 521, 522, 523, 524, 525, 526, 527, 529, 530]);

// A fetch rejection that proves the request never left this machine.
const NEVER_CONNECTED = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "EADDRNOTAVAIL"]);

// Transport failures where the request may have been in flight when it died.
const IN_FLIGHT_TRANSPORT = /aborted|timeout|timed out|fetch failed|socket hang up|ECONNRESET|ETIMEDOUT|EPIPE|terminated|network/i;

function statusOf(error: unknown): number | undefined {
  const e = error as { statusCode?: unknown; status?: unknown } | undefined;
  if (typeof e?.statusCode === "number") return e.statusCode; // @blockrun/llm APIError
  if (typeof e?.status === "number") return e.status; // @anthropic-ai/sdk APIError
  return undefined;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    const causeMsg = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
    return `${error.message} ${causeMsg}`;
  }
  return String(error);
}

export function settlementOnThrow(
  error: unknown,
  opts: {
    rail: "wallet" | "account";
    estimateUsd: number;
    /**
     * The native claude-* path: @blockrun/llm's AnthropicClient pays the 402
     * INSIDE its fetch, so the status the SDK surfaces is already the paid
     * retry's — there is no "after payment" prefix to read. A 4xx there is the
     * gateway's refusal before settlement (its /v1/messages route passes 4xx
     * through and does not settle); anything the origin did not answer, or a
     * 5xx, may have settled.
     */
    transparentPayment?: boolean;
  },
): SettlementVerdict {
  // A $0 estimate is a free model: whatever happened, it cannot have cost
  // anything, and mode:"free" must keep walking its candidates.
  if (!(opts.estimateUsd > 0)) return "none";
  if (error instanceof AcceptedThenFailedError) return "settled";

  const name = (error as { name?: unknown } | undefined)?.name;
  const msg = messageOf(error);
  const lower = msg.toLowerCase();

  // The wallet could not or would not pay: the SDK's PaymentError, or the same
  // sentence surfaced through the Anthropic SDK's connection-error wrapper.
  if (name === "PaymentError" || /payment was rejected|no payment requirements|insufficient|check your .*balance/i.test(msg)) return "none";
  // Refused by this process before anything was sent.
  if (name === "BudgetExceededError" || name === "QuoteMismatchError") return "none";

  const cause = (error as { cause?: { code?: unknown } } | undefined)?.cause;
  if (typeof cause?.code === "string" && NEVER_CONNECTED.has(cause.code)) return "none";

  const status = statusOf(error);
  if (status !== undefined) {
    if (opts.rail === "wallet") {
      // "API error: N" is the UNPAID first response — the gateway wants a
      // payment it never got, or refused the request outright. No money.
      // "API error after payment: N" is the paid retry: a 4xx there is the
      // gateway's own refusal before settlement starts (its streaming route
      // says so in as many words); an edge timeout may hide a settle.
      if (!opts.transparentPayment && !lower.includes("after payment")) return "none";
      return ORIGIN_DID_NOT_ANSWER.has(status) ? "unknown" : status >= 500 ? "unknown" : "none";
    }
    // Account rail: every non-OK first response throws with its status before
    // any body exists — 400 unknown model, 401, 402 out of credit, 429 — and
    // none of those is billed. Only an origin that did not answer is ambiguous.
    return ORIGIN_DID_NOT_ANSWER.has(status) ? "unknown" : "none";
  }

  // No status: a transport failure. Before headers on a paid call the payment
  // has already been signed and sent (the unpaid 402 comes back in
  // milliseconds; the paid retry is the one that runs long), so an abort here
  // is exactly the settle-after-disconnect shape. Anything else without a
  // status — an SDK validation throw, a programming error — never reached
  // the wire.
  if (name === "AbortError" || IN_FLIGHT_TRANSPORT.test(msg)) return "unknown";
  return "none";
}
