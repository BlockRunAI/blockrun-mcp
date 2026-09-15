// src/tools/chat-anthropic.ts
//
// Native Anthropic passthrough for blockrun_chat.
//
// When an explicit anthropic/claude-* model is requested, we bypass the
// OpenAI-compatible /v1/chat/completions path entirely and call the gateway's
// native /v1/messages endpoint via @blockrun/llm's AnthropicClient (which wraps
// the official @anthropic-ai/sdk over an x402-paying fetch). The gateway
// forwards Claude requests to api.anthropic.com VERBATIM — zero model
// substitution, no cost routing, no fallback — so the response carries the real
// native signals: type:"thinking" blocks with their original signature.
//
// The OpenAI-compat path cannot do this: it flattens thinking to a
// reasoning_content string and drops thought signatures in conversion. So
// claude-* always takes this path and never falls through to routing/fallback.
import type Anthropic from "@anthropic-ai/sdk";
import { extractErrorMessage, formatError } from "../utils/errors.js";
import { recordActualSpend } from "../utils/budget.js";
import { isApiKeyMode } from "../utils/auth.js";
import { OBSERVED_GATEWAY_TX_FEE_USD } from "../utils/tx-fee.js";
import { CHAT_PRICE_PER_MTOKEN, GATEWAY_CHARS_PER_TOKEN_OBSERVED } from "../utils/constants.js";
import { AcceptedThenFailedError, settlementOnThrow, settledCostFromHeaders } from "../utils/chat-stream.js";
import type { BudgetState } from "../types.js";

/**
 * Reconstruct what the GATEWAY charged for a native Anthropic call.
 *
 * The AnthropicClient settles the 402 internally and never exposes the amount,
 * so the charge has to be recomputed here — but from the gateway's pricing, not
 * from the tokens the response reports.
 *
 * This used to multiply the response's own `usage` by ANTHROPIC'S PUBLIC LIST
 * RATES ($15/$75 for opus, $1/$5 for haiku). Three things were wrong with that,
 * compounding in the same direction:
 *
 *   1. The gateway resells opus at $5/$25, not $15/$75 — 3x over on the rate.
 *   2. Settlement collects the QUOTE, and the quote prices output at
 *      OUTPUT_QUOTE_FACTOR (0.1) of max_tokens, not at tokens actually produced
 *      ("Settlement charges the full quoted amount regardless of actual usage"
 *      — the gateway's own comment on that constant).
 *   3. There is a $0.001 floor and a flat transaction fee on top, and neither
 *      appeared at all.
 *
 * Net effect measured: a claude-opus-5 call with the default max_tokens settles
 * $0.003660, and the old path booked $0.03 for it — the ledger over-counted 8x,
 * so a budget cap tripped at an eighth of its real allowance.
 *
 * The formula below is the gateway's, mirrored. Verified against live unpaid 402
 * quotes on /v1/messages, 2026-08-13 — accurate to +0.16% across a 100x span of
 * prompt sizes and both price tiers, erring high:
 *
 *   opus-5  "hi"   max_tokens 1024 -> quoted 3660     reconstructed 3665
 *   opus-5  "hi"   max_tokens 4096 -> quoted 11336    reconstructed 11345
 *   opus-5  "hi"   max_tokens  100 -> quoted 2000     reconstructed 2000  (floor)
 *   opus-5   10k   max_tokens 1024 -> quoted 27656    reconstructed 27700
 *   opus-5  100k   max_tokens 1024 -> quoted 243655   reconstructed 244045
 *   haiku   "hi"   max_tokens 1024 -> quoted 2000     reconstructed 2000  (floor)
 *
 * `usage` is deliberately NOT consulted: real output tokens do not move the
 * price. Returns null only when the model is unknown, so the caller falls back
 * to the pre-call estimate.
 */
// The gateway quotes output at this fraction of max_tokens and settles the quote
// (OUTPUT_QUOTE_FACTOR in blockrun/src/lib/models.ts). If that constant moves,
// this books low — it is the one number here we do not own.
const OUTPUT_QUOTE_FACTOR = 0.1;
// The gateway's own per-message envelope overhead, fitted from the probes above
// (~20 tokens on a 2-character message). Keeps small calls from booking under.
const MESSAGE_TOKEN_OVERHEAD = 20;
const MIN_BASE_USD = 0.001;

/**
 * Map the id the gateway ECHOES onto the id the catalogue KEYS on.
 *
 * /v1/messages echoes the upstream Anthropic id (blockrun's ANTHROPIC_MODEL_MAP),
 * not the id that was requested: "anthropic/claude-fable-5.1" comes back as
 * "claude-fable-5-1", "anthropic/claude-haiku-4.5" as
 * "claude-haiku-4-5-20251001". Three differences, undone in order: the vendor
 * prefix is missing, a -YYYYMMDD snapshot date may be appended, and the minor
 * version is dashed where the catalogue spells it dotted. Nothing else is
 * touched, so an id this does not recognise misses the table and books null.
 */
function catalogueKeyForEcho(model: string): string {
  let id = model.trim();
  if (!id.startsWith("anthropic/")) id = `anthropic/${id}`;
  id = id.replace(/-\d{8}$/, "");
  id = id.replace(/^(anthropic\/claude-[a-z]+-\d+)-(\d+)$/, "$1.$2");
  return id;
}

export function anthropicCallCost(
  model: string,
  promptChars: number,
  maxTokens: number,
): number | null {
  const id = catalogueKeyForEcho(model);
  // hasOwn, not `??` — see the note in estimateChatCost: an inherited
  // Object.prototype member would pass the null check and poison the arithmetic.
  // (`id` is always prefixed with "anthropic/" here, so it cannot BE a prototype
  // key; guarded anyway so the pattern is uniform wherever these tables are read.)
  //
  // Exact match ONLY. This used to fall back to a startsWith prefix match, meant
  // for date-suffixed echoes — but the gateway echoes DASHED upstream ids, so
  // the prefix never matched a dated echo at all (claude-haiku-4-5-20251001
  // does not start with anthropic/claude-haiku-4.5) and every one of them
  // silently booked the pre-call estimate. Its one live use was matching a
  // VERSION suffix: claude-fable-5-1 booked claude-fable-5's row. Right by
  // coincidence (both $10/$50) — and a sibling priced differently from its
  // major would have booked the wrong number with no signal, because the
  // "null -> estimate" fallback cannot engage once a rate WAS found. On this
  // path the table is the ledger, so a borrowed rate is a wrong budget.spent.
  const rate = Object.hasOwn(CHAT_PRICE_PER_MTOKEN, id) ? CHAT_PRICE_PER_MTOKEN[id] : undefined;
  if (!rate) return null;

  const inputTokens = Math.ceil(promptChars / GATEWAY_CHARS_PER_TOKEN_OBSERVED) + MESSAGE_TOKEN_OVERHEAD;
  const base =
    (inputTokens / 1_000_000) * rate.input +
    ((maxTokens * OUTPUT_QUOTE_FACTOR) / 1_000_000) * rate.output;
  // The OBSERVED fee, not the reserved one: this figure is the ledger entry, and
  // booking $0.001 that never left the wallet would trip budget caps early.
  const charged = Math.max(base, MIN_BASE_USD) + OBSERVED_GATEWAY_TX_FEE_USD;
  return Math.ceil(charged * 1e6) / 1e6; // the gateway settles in whole micro-USDC
}

/**
 * The ACCOUNT rail's ledger entry for a native call, when the response carried
 * no `x-blockrun-cost-usd` (chat settles after the response, so it never does).
 *
 * Not anthropicCallCost: that is the x402 QUOTE the wallet rails settle —
 * output at 0.1x max_tokens, a $0.001 floor, the observed transaction fee —
 * and api.blockrun.ai settles none of it. It bills exact usage, base rate with
 * no fee and no floor (reconciled against the dashboard 2026-09-05). Booking
 * the quote formula here added $0.001 to every call on a rail that charges no
 * fee — a $1 delegate cut off at 500 haiku calls that had cost $0.50 (D58).
 *
 * `usage` is the response's own input/output token counts when the call
 * completed; on a failure after acceptance there is none, so the prompt at the
 * observed chars/token and the full max_tokens stand in — the conservative
 * side for a call that reported nothing. Null when the model has no row, so
 * the caller falls back to the pre-call estimate.
 */
export function anthropicAccountLedgerUsd(
  model: string,
  promptChars: number,
  maxTokens: number,
  usage: { input_tokens: number; output_tokens: number } | null,
): number | null {
  const id = catalogueKeyForEcho(model);
  const rate = Object.hasOwn(CHAT_PRICE_PER_MTOKEN, id) ? CHAT_PRICE_PER_MTOKEN[id] : undefined;
  if (!rate) return null;
  const inputTokens = usage?.input_tokens ?? Math.ceil(promptChars / GATEWAY_CHARS_PER_TOKEN_OBSERVED) + MESSAGE_TOKEN_OVERHEAD;
  const outputTokens = usage?.output_tokens ?? maxTokens;
  const usd = (inputTokens / 1_000_000) * rate.input + (outputTokens / 1_000_000) * rate.output;
  return Math.ceil(usd * 1e6 - 1e-6) / 1e6; // whole micro-dollars, float noise excluded
}

// AnthropicClient.messages is typed as the official SDK's Messages resource.
type AnthropicLike = { messages: Anthropic["messages"] };

/**
 * Nothing streamed for this long means the connection is dead, not slow: the
 * API sends `ping` events every few seconds while a long thinking budget runs,
 * and the gateway forwards them. Same figure as the OpenAI-compat assembler.
 */
const NATIVE_IDLE_TIMEOUT_MS = 120_000;

/**
 * Run the native call as a STREAM and assemble the final Message.
 *
 * Streaming, not create(): two reasons, both money or reach.
 *
 *   1. @anthropic-ai/sdk refuses a non-streaming request whose max_tokens
 *      could run past ten minutes — `calculateNonstreamingTimeout` throws
 *      "Streaming is required for operations that may take longer than 10
 *      minutes" above 21,333 tokens — and effectiveMax is budget_tokens + 1024,
 *      so every thinking budget from 20,310 up to the schema's 100,000 died in
 *      this process with an error that blamed the caller (D51). The check is
 *      skipped when `stream` is set.
 *   2. A non-streaming request moves zero bytes while Claude thinks, and the
 *      edge in front of the gateway 524s the idle connection at ~100s — after
 *      the gateway verified the payment. Streaming keeps bytes flowing (pings,
 *      thinking deltas), the same fix chat-stream.ts made for the compat paths.
 *
 * `maxRetries: 0`, always. @blockrun/llm builds the official SDK at its default
 * of two retries with a fetch that signs a FRESH x402 payment on every 402 it
 * sees — the PAYMENT-SIGNATURE header lives on a local copy, never on the
 * SDK's request init — so a 5xx/524/timeout after settlement was retried up to
 * twice more, each retry a new USDC settlement for an undelivered answer, none
 * of it visible to the ledger (C20). The gateway already saw the payment; a
 * retry is a second purchase, and the routing loop's one-settlement rule
 * belongs here too. (The account rail's client is built with maxRetries 0 by
 * the SDK itself; passing it per request covers both.)
 *
 * The SDK's MessageStream accumulates thinking and signature deltas, so the
 * assembled Message carries the same verbatim thinking blocks the non-streaming
 * response did — the test against the real SDK pins that.
 *
 * `accepted` is whether the stream CONNECTED (the SDK emits `connect` once the
 * 2xx is in, before the first event). A throw after that point is wrapped as
 * AcceptedThenFailedError: the payment settled (wallet) or the request is
 * billed (account), and the caller books it.
 */
async function streamNativeMessage(
  client: AnthropicLike,
  params: Anthropic.MessageStreamParams,
  idleTimeoutMs = NATIVE_IDLE_TIMEOUT_MS,
): Promise<{ message: Anthropic.Message; costHeaderUsd: number | null }> {
  // The @blockrun/llm proxy wraps every messages.* call in an async function,
  // so the MessageStream arrives behind a promise; the SDK returns it directly.
  const stream = await client.messages.stream(params, { maxRetries: 0 });
  let accepted = false;
  stream.on("connect", () => { accepted = true; });
  // What streamed before a failure: the caller paid for those tokens, and the
  // compat assembler hands them back (D57); the native path dropped them
  // until round 4b. The SDK's `text` event carries the running snapshot.
  let partialText = "";
  stream.on("text", (_delta: string, snapshot: string) => { partialText = snapshot; });

  // Idle guard, reset on every event. The SDK has no per-event deadline of its
  // own — its request timeout ends at the headers — and the fetch underneath
  // clears its abort timer at the same point.
  let idleTimer: NodeJS.Timeout | undefined;
  let stalled: (err: Error) => void = () => undefined;
  const stall = new Promise<never>((_, reject) => { stalled = reject; });
  const armIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      // A stall AFTER the 2xx is a settled call that went quiet; a stall
      // BEFORE it is the paid request still in flight — a maybe, the same
      // verdict the compat path gives its own "before the first frame"
      // stall — never "the charge stands" (round 4b).
      const what = `stream stalled: no data from the gateway for ${Math.round(idleTimeoutMs / 1000)}s`;
      stalled(accepted ? new AcceptedThenFailedError(what, partialText) : new Error(`timeout: ${what}, before the stream connected`));
      stream.abort();
    }, idleTimeoutMs);
  };
  stream.on("streamEvent", armIdle);
  armIdle();
  try {
    const message = await Promise.race([stream.finalMessage(), stall]);
    return { message, costHeaderUsd: settledCostFromHeaders(stream.response?.headers) };
  } catch (error) {
    if (error instanceof AcceptedThenFailedError) throw error;
    if (accepted) {
      throw new AcceptedThenFailedError(error instanceof Error ? error.message : String(error), partialText, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(idleTimer);
  }
}

/**
 * The note for a native call that cost money — or may have — and then failed.
 * Same voice as chat.ts's settledThenFailedText; the two paths book the same
 * way and must read the same way to the agent acting on them.
 */
function nativeFailedText(error: unknown, usd: number, certainty: "settled" | "unknown"): string {
  const amount = `$${usd.toFixed(6)}`;
  const what = isApiKeyMode()
    ? certainty === "settled"
      ? `Note: the gateway had accepted this request (HTTP 200) before it failed, so it is billed to your BlockRun account at exact usage — ` +
        `an estimated ~${amount} has been recorded against your budget; https://user.blockrun.ai/dashboard/activity has the exact figure.`
      : `Note: this request MAY have been billed to your BlockRun account — no response was observed, so this process cannot tell. ` +
        `An estimated ~${amount} has been recorded against your budget as a precaution; https://user.blockrun.ai/dashboard/activity has the truth.`
    : certainty === "settled"
      ? `Note: payment had already settled when this failed, so the charge stands (~${amount}, the reconstructed quote) and it has been recorded against your budget.`
      : `Note: the payment for this call had been signed and sent before it failed, and this process cannot tell whether the gateway settled it — ` +
        `it may have settled after the connection dropped. The reconstructed quote (${amount}) has been recorded against your budget as a precaution.`;
  return `${formatError(extractErrorMessage(error))}\n\n${what} Retrying will incur a second charge — check blockrun_wallet action:"report" first.`;
}

type TextPart = { type: "text"; text: string };
type ImagePart = { type: "image_url"; image_url: { url: string } };
type ContentPart = TextPart | ImagePart;
type InboundContent = string | ContentPart[];
type InboundMessage = { role: "user" | "assistant" | "system"; content: InboundContent };

export interface AnthropicNativeArgs {
  client: AnthropicLike;
  model: string;
  message: string;
  system?: string;
  messages?: InboundMessage[];
  maxTokens?: number;
  temperature?: number;
  stop?: string[];
  thinking?: { type: "enabled"; budget_tokens: number };
  // Anthropic's /v1/messages has no OpenAI-style response_format field, so JSON
  // mode is honored by injecting a system instruction instead.
  responseFormat?: { type: "text" | "json_object" };
  budget: BudgetState;
  agentId?: string;
  estimatedCost: number;
  /** Test seam for the idle guard; production uses NATIVE_IDLE_TIMEOUT_MS. */
  idleTimeoutMs?: number;
}

type McpResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/** True for explicit Anthropic Claude model ids: "anthropic/claude-…" or bare "claude-…". */
export function isAnthropicModel(model: string): boolean {
  const id = model.trim();
  return /^anthropic\//i.test(id) || /^claude-/i.test(id);
}

/** Parse a data: URI into the components Anthropic's base64 image source needs.
 * Tolerates the common `jpg` alias and extra parameters (e.g. `;name=x`); rejects
 * media types Anthropic doesn't accept so the caller can skip them. */
function parseDataUri(url: string): Anthropic.Base64ImageSource | null {
  const match = /^data:image\/([a-z0-9.+-]+)(?:;[^;,]+)*;base64,(.+)$/i.exec(url.trim());
  if (!match) return null;
  let subtype = match[1].toLowerCase();
  if (subtype === "jpg") subtype = "jpeg";
  if (!["jpeg", "png", "gif", "webp"].includes(subtype)) return null;
  return {
    type: "base64",
    media_type: `image/${subtype}` as Anthropic.Base64ImageSource["media_type"],
    data: match[2],
  };
}

/** Convert an OpenAI-style content part array to native Anthropic content blocks. */
function toAnthropicContent(content: InboundContent): string | Anthropic.ContentBlockParam[] {
  if (typeof content === "string") return content;
  const blocks: Anthropic.ContentBlockParam[] = [];
  for (const part of content) {
    if (part.type === "text") {
      if (part.text) blocks.push({ type: "text", text: part.text });
    } else if (part.type === "image_url") {
      const url = part.image_url?.url;
      if (!url) continue;
      if (/^data:/i.test(url)) {
        // A data: URI must be sent as a base64 source — forwarding it as a
        // type:"url" source 400s upstream. Skip an unsupported/malformed one.
        const base64 = parseDataUri(url);
        if (!base64) continue;
        blocks.push({ type: "image", source: base64 });
      } else {
        blocks.push({ type: "image", source: { type: "url", url } as Anthropic.URLImageSource });
      }
    }
  }
  return blocks;
}

function isTextBlock(b: Anthropic.ContentBlock): b is Anthropic.TextBlock {
  return b.type === "text";
}
function isThinkingBlock(b: Anthropic.ContentBlock): b is Anthropic.ThinkingBlock {
  return b.type === "thinking";
}

export async function handleAnthropicNative(args: AnthropicNativeArgs): Promise<McpResult> {
  const {
    client, model, message, system, messages,
    maxTokens, temperature, stop, thinking, responseFormat,
    budget, agentId, estimatedCost,
  } = args;

  // Native Anthropic carries `system` as a top-level param, not a message role.
  // Fold any role:"system" history entries into it so nothing is silently lost.
  const systemParts: string[] = [];
  if (system) systemParts.push(system);

  const apiMessages: Anthropic.MessageParam[] = [];
  for (const m of messages ?? []) {
    if (m.role === "system") {
      const text = typeof m.content === "string"
        ? m.content
        : m.content.filter((p): p is TextPart => p.type === "text").map((p) => p.text).join("\n");
      if (text) systemParts.push(text);
      continue;
    }
    const content = toAnthropicContent(m.content);
    // A content array that reduced to nothing (e.g. only an unsupported image)
    // would 400 as an empty-content message — drop the turn instead.
    if (Array.isArray(content) && content.length === 0) continue;
    apiMessages.push({ role: m.role, content });
  }
  // JSON mode: /v1/messages has no response_format param, so steer the model
  // with a system instruction (keeps the documented "works across all
  // providers" promise true for the native Claude path).
  if (responseFormat?.type === "json_object") {
    systemParts.push("Respond with only valid JSON. Do not wrap it in markdown code fences or add any prose before or after.");
  }

  // `message` is the final user turn (matches the OpenAI multi-turn convention).
  if (message.trim()) apiMessages.push({ role: "user", content: message });
  if (apiMessages.length === 0) {
    return { content: [{ type: "text", text: "No message content to send." }], isError: true };
  }

  // Anthropic requires max_tokens > thinking.budget_tokens. Auto-raise the cap
  // (with headroom for the answer) instead of letting the call 400.
  let effectiveMax = maxTokens ?? 1024;
  let raisedMaxTokens = false;
  if (thinking && effectiveMax <= thinking.budget_tokens) {
    effectiveMax = thinking.budget_tokens + 1024;
    raisedMaxTokens = true;
  }

  // Everything the gateway will count as prompt: the system block plus every
  // message body, measured the same way promptCharSize does for the OpenAI-compat
  // paths. Used only to reconstruct the settled charge below.
  const anthropicPromptChars =
    (systemParts.join("\n\n").length) +
    apiMessages.reduce((n: number, m: { content: unknown }) => n + (typeof m.content === "string"
      ? m.content.length
      : JSON.stringify(m.content ?? "").length), 0);

  const params: Anthropic.MessageStreamParams = {
    model,
    max_tokens: effectiveMax,
    messages: apiMessages,
  };
  if (systemParts.length) params.system = systemParts.join("\n\n");
  if (stop && stop.length) params.stop_sequences = stop;
  if (thinking) {
    // Extended thinking requires temperature to be unset (defaults to 1);
    // sending a custom temperature alongside thinking is rejected upstream.
    params.thinking = { type: "enabled", budget_tokens: thinking.budget_tokens };
  } else if (temperature !== undefined) {
    // The schema allows 0–2 (OpenAI range); Anthropic caps temperature at 1.
    params.temperature = Math.max(0, Math.min(1, temperature));
  }

  // What a failure after the money moved is booked at. The wallet rails settle
  // the quote (anthropicCallCost); the account rail bills exact usage, which a
  // failed call never reports, so its ledger figure is the model's rate over
  // the prompt and the full max_tokens. Either falls back to the reserve when
  // the model has no row.
  const failedLedgerUsd = () => (isApiKeyMode()
    ? anthropicAccountLedgerUsd(model, anthropicPromptChars, effectiveMax, null)
    : anthropicCallCost(model, anthropicPromptChars, effectiveMax)) ?? estimatedCost;

  let native: Anthropic.Message;
  let costHeaderUsd: number | null;
  try {
    ({ message: native, costHeaderUsd } = await streamNativeMessage(client, params, args.idleTimeoutMs));
  } catch (error) {
    // Until audit round 3 this returned formatError and booked nothing, on
    // both rails — the settled-then-failed machinery the OpenAI-compat paths
    // gained in 0.40.1/0.49.0/0.50.0 never reached here, so a 524 after the
    // gateway settled read as "temporary API issue, try again" and the agent
    // paid again (C20). Same classifier as those paths: a 4xx before the
    // stream connected (the gateway's own refusal, or the SDK's) and a
    // payment the wallet could not make are not money; a failure after the
    // 2xx is; an origin that never answered may be.
    const verdict = settlementOnThrow(error, { rail: isApiKeyMode() ? "account" : "wallet", estimateUsd: estimatedCost, transparentPayment: true });
    if (verdict === "none") {
      return { content: [{ type: "text", text: formatError(extractErrorMessage(error)) }], isError: true };
    }
    const usd = failedLedgerUsd();
    recordActualSpend(budget, usd, estimatedCost, agentId);
    const partial = error instanceof AcceptedThenFailedError && error.partialText ? error.partialText : "";
    return {
      content: [{ type: "text", text: nativeFailedText(error, usd, verdict) + (partial ? `\n\nPartial response received before the failure (${partial.length.toLocaleString("en-US")} chars):\n${partial}` : "") }],
      ...(partial ? { structuredContent: { partial_response: partial } } : {}),
      isError: true,
    };
  }

  // Book what the gateway actually charged: on the wallet rails the quote it
  // settled (anthropicCallCost) — not the flat estimate and not a token
  // reconstruction at Anthropic's list prices; on the account rail the
  // response's settled cost when it carried one, else exact usage at the
  // model's rate (anthropicAccountLedgerUsd), labelled as the estimate it is.
  // effectiveMax is the max_tokens the request was sent with — including the
  // auto-raise for a thinking budget, which is what the quote was priced on.
  const bookedUsd = isApiKeyMode()
    ? (costHeaderUsd ?? anthropicAccountLedgerUsd(native.model, anthropicPromptChars, effectiveMax, native.usage))
    : anthropicCallCost(native.model, anthropicPromptChars, effectiveMax);
  const costIsEstimate = isApiKeyMode() && costHeaderUsd === null;
  recordActualSpend(budget, bookedUsd, estimatedCost, agentId);
  const costLine = costIsEstimate && bookedUsd !== null && bookedUsd > 0
    ? `\n\n(Cost: ~$${bookedUsd.toFixed(4)}, estimated — billed to your BlockRun account at exact usage; https://user.blockrun.ai/dashboard/activity has the figure.)`
    : "";

  const thinkingBlocks = native.content.filter(isThinkingBlock);
  const textBlocks = native.content.filter(isTextBlock);
  const answerText = textBlocks.map((b) => b.text).join("\n");
  const thinkingText = thinkingBlocks.map((b) => b.thinking).join("\n");
  const signaturePresent = thinkingBlocks.some(
    (b) => typeof b.signature === "string" && b.signature.length > 0,
  );

  const headerBits = [native.model, "native /v1/messages", `thinking ${thinking ? "on" : "off"}`];
  if (raisedMaxTokens) headerBits.push(`max_tokens→${effectiveMax}`);
  const header = `[${headerBits.join(" | ")}]`;

  // stop_reason "max_tokens" is the native spelling of a reply cut short;
  // surfaced in the text as the compat paths do, not only in structuredContent.
  const truncated = native.stop_reason === "max_tokens"
    ? `\n\n⚠️ TRUNCATED OUTPUT: the reply hit max_tokens=${effectiveMax} and stopped mid-way (stop_reason "max_tokens"). ` +
      `Raise max_tokens to get the rest — thinking tokens count against it too.`
    : "";

  const content: { type: "text"; text: string }[] = [{ type: "text", text: `${header}\n\n${answerText}${truncated}${costLine}` }];
  if (thinkingText) {
    content.push({ type: "text", text: `🧠 Thinking (signature ${signaturePresent ? "present" : "absent"}):\n${thinkingText}` });
  }

  return {
    content,
    structuredContent: {
      requested_model: model,
      // Verbatim upstream model id — proof the call hit real Claude with no
      // substitution. Intentionally NOT rewritten back to the requested id.
      model: native.model,
      response: answerText,
      thinking: thinkingText || undefined,
      // Native thinking blocks verbatim, including their original signature.
      thinking_blocks: thinkingBlocks,
      signature_present: signaturePresent,
      stop_reason: native.stop_reason,
      ...(native.stop_reason === "max_tokens" ? { truncated_output: true } : {}),
      usage: native.usage,
      cost_usd: bookedUsd ?? estimatedCost,
      cost_is_estimate: costIsEstimate || bookedUsd === null,
      native,
    },
  };
}
