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
import type { BudgetState } from "../types.js";

/**
 * Reconstruct the real cost of a native Anthropic call from its token usage.
 * The AnthropicClient settles the 402 internally and never exposes the amount,
 * so token-count × the model's published per-1M rate is the best signal we have
 * (vastly better than a flat estimate). Rates mirror Anthropic's public pricing;
 * unknown ids fall back to a conservative Sonnet-ish default. Returns null when
 * usage is absent so the caller falls back to the pre-call estimate.
 */
function anthropicCallCost(
  model: string,
  usage?: { input_tokens?: number; output_tokens?: number } | null,
): number | null {
  if (!usage) return null;
  const id = model.toLowerCase();
  let inRate = 5, outRate = 25; // safe default (≈ Sonnet, slightly high)
  if (id.includes("opus")) { inRate = 15; outRate = 75; }
  else if (id.includes("haiku")) { inRate = 1; outRate = 5; }
  else if (id.includes("sonnet")) { inRate = 3; outRate = 15; }
  const cost =
    ((usage.input_tokens ?? 0) / 1_000_000) * inRate +
    ((usage.output_tokens ?? 0) / 1_000_000) * outRate;
  return cost > 0 ? cost : null;
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

  // Book the real cost derived from native token usage, not the flat estimate.
  recordActualSpend(budget, anthropicCallCost(native.model, native.usage), estimatedCost, agentId);

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
