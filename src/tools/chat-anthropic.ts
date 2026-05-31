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
import { formatError } from "../utils/errors.js";
import { recordSpending } from "../utils/budget.js";
import type { BudgetState } from "../types.js";

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

/** Parse a data: URI into the components Anthropic's base64 image source needs. */
function parseDataUri(url: string): Anthropic.Base64ImageSource | null {
  const match = /^data:(image\/(?:jpeg|png|gif|webp));base64,(.+)$/i.exec(url.trim());
  if (!match) return null;
  return {
    type: "base64",
    media_type: match[1].toLowerCase() as Anthropic.Base64ImageSource["media_type"],
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
      const base64 = parseDataUri(url);
      const source: Anthropic.ImageBlockParam["source"] = base64
        ? base64
        : ({ type: "url", url } as Anthropic.URLImageSource);
      blocks.push({ type: "image", source });
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
    maxTokens, temperature, stop, thinking,
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
    apiMessages.push({ role: m.role, content: toAnthropicContent(m.content) });
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
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { content: [{ type: "text", text: formatError(errorMessage) }], isError: true };
  }

  recordSpending(budget, estimatedCost, agentId);

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
