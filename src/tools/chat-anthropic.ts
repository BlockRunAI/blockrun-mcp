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
import { OBSERVED_GATEWAY_TX_FEE_USD } from "../utils/tx-fee.js";
import { CHAT_PRICE_PER_MTOKEN, GATEWAY_CHARS_PER_TOKEN_OBSERVED } from "../utils/constants.js";
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

export function anthropicCallCost(
  model: string,
  promptChars: number,
  maxTokens: number,
): number | null {
  // The catalog keys on the prefixed id; the response echoes a bare one
  // ("claude-opus-5"), sometimes with a date suffix.
  const id = model.startsWith("anthropic/") ? model : `anthropic/${model}`;
  // hasOwn, not `??` — see the note in estimateChatCost: an inherited
  // Object.prototype member would pass the null check and poison the arithmetic.
  // (`id` is always prefixed with "anthropic/" here, so it cannot BE a prototype
  // key; guarded anyway so the pattern is uniform wherever these tables are read.)
  const rate = Object.hasOwn(CHAT_PRICE_PER_MTOKEN, id)
    ? CHAT_PRICE_PER_MTOKEN[id]
    : Object.entries(CHAT_PRICE_PER_MTOKEN).find(([k]) => id.startsWith(k))?.[1];
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

// AnthropicClient.messages is typed as the official SDK's Messages resource.
type AnthropicLike = { messages: Anthropic["messages"] };

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

  const params: Anthropic.MessageCreateParamsNonStreaming = {
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

  let native: Anthropic.Message;
  try {
    native = await client.messages.create(params);
  } catch (error) {
    return { content: [{ type: "text", text: formatError(extractErrorMessage(error)) }], isError: true };
  }

  // Book what the gateway actually charged (the quote it settled), not the flat
  // estimate and not a token reconstruction at Anthropic's list prices.
  // effectiveMax is the max_tokens the request was sent with — including the
  // auto-raise for a thinking budget, which is what the quote was priced on.
  recordActualSpend(
    budget,
    anthropicCallCost(native.model, anthropicPromptChars, effectiveMax),
    estimatedCost,
    agentId,
  );

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

  const content: { type: "text"; text: string }[] = [{ type: "text", text: `${header}\n\n${answerText}` }];
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
      usage: native.usage,
      native,
    },
  };
}
