// src/tools/chat.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildClient, getAnthropicClient, baseOnlyMessage } from "../utils/wallet.js";
import { handleAnthropicNative, isAnthropicModel } from "./chat-anthropic.js";
import { extractErrorMessage, formatError } from "../utils/errors.js";
import { MODEL_TIERS, type RoutingMode } from "../utils/constants.js";
import { reserveBudget, recordActualSpend } from "../utils/budget.js";
import type { ApiClient } from "../utils/wallet.js";
import type { BudgetState } from "../types.js";

/**
 * Conservative per-call RESERVE for the budget pre-check (the gate). We don't
 * know a model's settled price until after the call, so for any path that CAN
 * pick an expensive model we reserve a frontier-ish worst-case scaled by
 * max_tokens — this stops a near-exhausted budget from authorizing one large
 * frontier completion. The post-call recordActualSpend() books the REAL settled
 * cost (LLMClient.getSpending delta), so over-reserving here only affects the
 * gate, never the ledger.
 */
export function estimateChatCost(
  maxTokens: number | undefined,
  mode: string | undefined,
  model: string | undefined,
  thinkingBudget?: number,
): number {
  // Free paths bypass the gate entirely.
  if (mode === "free") return 0;
  if (model?.startsWith("nvidia/")) return 0;

  // Anthropic bills extended-thinking tokens as output, so the thinking budget —
  // not max_tokens — is the dominant cost driver on the native claude-* path.
  // Fold it into the reserved output size so the gate can't be bypassed by a
  // tiny max_tokens + a huge budget_tokens.
  const out = Math.max((maxTokens ?? 1024) + (thinkingBudget ?? 0), 256);
  // ~$20 / 1M output tokens — a conservative upper bound covering premium
  // frontier output, floored so tiny completions still reserve something real.
  const frontierReserve = Math.max(0.01, (out / 1_000_000) * 20);

  // Any tier whose FIRST-CHOICE model is a frontier model, plus any explicit
  // single model, can settle at a price we can't know up front — reserve
  // conservatively. balanced[0] = openai/gpt-5.5 and coding[0] =
  // anthropic/claude-opus-4.8 (see MODEL_TIERS), the same frontier primaries as
  // reasoning/powerful, and a no-mode chat resolves to "balanced" (see the
  // routing loop below) — so undefined counts too. Reserving the cheap heuristic
  // for these let a near-exhausted budget authorize a frontier completion, and
  // let N concurrent default calls each pass the gate and collectively blow the
  // cap (the exact TOCTOU that reserveBudget exists to close).
  const effectiveMode = mode ?? "balanced";
  if (
    effectiveMode === "reasoning" ||
    effectiveMode === "powerful" ||
    effectiveMode === "balanced" ||
    effectiveMode === "coding"
  ) {
    return frontierReserve;
  }
  if (model) return frontierReserve;

  // Only the explicitly-cheap tiers (cheap/fast/glm) pick budget models.
  return Math.max(0.002, (out / 1_000_000) * 3);
}

/**
 * Settled cost of the LLMClient call that ran inside `run`, measured as the
 * delta of the client's own cumulative spend counter (getSpending().totalUsd),
 * which the SDK increments with the REAL on-chain amount per call. Returns the
 * result plus the booked cost so callers can record actual spend, falling back
 * to the estimate when the delta is unavailable (0/NaN).
 */
async function withSettledCost<T>(
  client: ApiClient,
  run: () => Promise<T>,
): Promise<{ result: T; settledUsd: number }> {
  const before = client.getSpending().totalUsd;
  const result = await run();
  const settledUsd = client.getSpending().totalUsd - before;
  return { result, settledUsd };
}

export function registerChatTool(server: McpServer, budget: BudgetState): void {
  server.registerTool(
    "blockrun_chat",
    {
      description: `Get a second opinion from another AI model, or use a specialized model for a specific task.

Notable modes:
- mode:"glm" → Zhipu GLM-5 / GLM-5-Turbo ($0.001/call, excellent for coding tasks, pays via USDC on BlockRun)
- mode:"coding" → GLM-5 first, then code-specialized models
- mode:"cheap" → GLM-5, NVIDIA free, DeepSeek
- mode:"reasoning" → Claude Opus, o3, o1, deepseek-reasoner
- mode:"free" → NVIDIA models (no cost)

Pick directly: model:"zai/glm-5", model:"openai/o3", model:"nvidia/deepseek-v4-flash" (free).

Run blockrun_models to see all available models with pricing.`,
      inputSchema: {
        message: z.string().describe("Your message to the AI"),
        model: z.string().optional().describe("Specific model ID (e.g., 'zai/glm-5', 'openai/o3')"),
        mode: z.enum(["fast", "balanced", "powerful", "cheap", "reasoning", "free", "coding", "glm"]).optional().describe("Routing mode: glm = Zhipu GLM-5/GLM-5-Turbo ($0.001/call, great for coding), coding = GLM-5 + code models, cheap = GLM-5 + budget, free = NVIDIA only (ignored if model specified)"),
        system: z.string().optional().describe("Optional system prompt"),
        max_tokens: z.number().optional().default(1024).describe("Max tokens in response"),
        temperature: z.number().optional().default(1).describe("Creativity 0-2"),
        response_format: z.enum(["text", "json_object"]).optional().describe("Set to 'json_object' to force valid JSON output (no markdown fences). Works across all providers."),
        stop: z.array(z.string()).max(4).optional().describe("Up to 4 stop sequences; generation halts when any is produced"),
        thinking: z.object({
          type: z.literal("enabled"),
          budget_tokens: z.number().int().min(1024).max(100_000).describe("Tokens Claude may spend reasoning before answering (1024–100000; Anthropic requires ≥1024). max_tokens is auto-raised above this if needed; counts toward the budget reserve."),
        }).optional().describe("Anthropic extended thinking. Only honored for anthropic/claude-* models — these go direct to the native /v1/messages endpoint and the response includes verbatim type:'thinking' blocks with their original signature. Ignored for non-Claude models (no native thinking channel)."),
        agent_id: z.string().optional().describe("Agent identifier. If a budget was delegated for this agent_id via blockrun_wallet action:'delegate', spending is tracked and enforced. The agent is hard-stopped when its budget is exhausted."),
        messages: z.array(z.object({
          role: z.enum(["user", "assistant", "system"]),
          content: z.union([
            z.string(),
            z.array(z.union([
              z.object({ type: z.literal("text"), text: z.string() }),
              z.object({ type: z.literal("image_url"), image_url: z.object({ url: z.string().describe("https URL or data:<mime>;base64,<...> URI") }) }),
            ])),
          ]).describe("Plain text, or an array of parts for multimodal input (text + image_url). Images are honored on the native anthropic/claude-* path."),
        })).optional().describe("Conversation history for multi-turn context. When provided, 'message' is appended as the final user turn. Use with explicit 'model' param (defaults to 'openai/gpt-5.5' if not specified). Note: if you include a role:'system' entry in messages[], do not also pass the system param to avoid duplicate system messages."),
      },
    },
    async ({ message, model, mode, system, max_tokens, temperature, response_format, stop, thinking, agent_id, messages }) => {
      // Fresh per-call client so withSettledCost's getSpending() delta isolates
      // THIS call's cost (the shared singleton's cumulative counter double-counts
      // concurrent calls — see buildClient).
      const llm = buildClient();

      // OpenAI-compatible response shaping, forwarded to every call path below.
      const responseFormat = response_format ? ({ type: response_format } as const) : undefined;

      // Budget gate: global + per-agent enforcement. The tier/model is resolved
      // AFTER the gate, so reserve the worst case it could settle at.
      const estimatedCost = estimateChatCost(max_tokens, mode, model, thinking?.budget_tokens);
      // Reserve the estimate up front so concurrent calls can't each pass a
      // stale budget; release in finally once the call settles or fails (the
      // real settled cost is booked separately via recordActualSpend).
      const gate = reserveBudget(budget, agent_id, estimatedCost);
      if (!gate.allowed) {
        return {
          content: [{ type: "text", text: `${gate.reason}. Use blockrun_wallet with action: "report" to see usage, or action: "delegate" to increase agent budget.` }],
          isError: true,
        };
      }
      try {

      // Native Anthropic passthrough (EVM/Base only).
      // An explicit anthropic/claude-* model goes DIRECT to the gateway's
      // /v1/messages endpoint, which forwards to api.anthropic.com VERBATIM:
      // zero model substitution, no cost routing, no fallback, and the real
      // native response — type:"thinking" blocks with their original signature.
      // This takes priority over mode/routing precisely because the requirement
      // is "claude-* must be verbatim, never routed". The OpenAI-compat paths
      // below cannot carry thinking signatures, so claude never falls through.
      if (model && isAnthropicModel(model)) {
        const solanaBlock = baseOnlyMessage("Native Anthropic (claude-*) calls");
        if (solanaBlock) {
          return { content: [{ type: "text", text: solanaBlock }], isError: true };
        }
        return await handleAnthropicNative({
          client: getAnthropicClient(),
          model,
          message,
          system,
          messages,
          maxTokens: max_tokens,
          temperature,
          stop,
          thinking,
          responseFormat,
          budget,
          agentId: agent_id,
          estimatedCost,
        });
      }

      // NOTE: routing:"smart" (llm.smartChat → @blockrun/clawrouter) was removed in
      // 0.30.6. It auto-picked the cheapest capable model, which serves an agent
      // that has no model of its own — but every caller here is already running
      // inside a frontier model and reaches for this tool to get what that model
      // LACKS: a specific model, an image, live X data. It was the sole reason the
      // router was in our dependency tree (~50MB, ~15% of the install), and the sole
      // reason clawrouter@0.12.220's broken bundle could take this server down.
      // Callers wanting a cheap model should pass mode:"cheap"/"glm" or an explicit
      // model — both resolve here, with no router.

      // Multi-turn conversation
      if (messages && messages.length > 0) {
        const targetModel = model || MODEL_TIERS[(mode ?? "balanced") as RoutingMode]?.[0] || "openai/gpt-5.5";
        const fullMessages = [
          ...(system ? [{ role: "system" as const, content: system }] : []),
          ...messages,
          { role: "user" as const, content: message },
        ];
        try {
          // The SDK types ChatMessage.content as string-only, but the gateway
          // forwards `messages` verbatim and accepts image_url content arrays
          // for vision-capable models — so a multimodal array is runtime-valid.
          // (claude-* with history is already handled by the native branch above.)
          const { result, settledUsd } = await withSettledCost(llm, () => llm.chatCompletion(targetModel, fullMessages as unknown as Parameters<typeof llm.chatCompletion>[1], {
            maxTokens: max_tokens,
            temperature,
            responseFormat,
            stop,
          }));
          const reply = result.choices?.[0]?.message?.content || "";
          recordActualSpend(budget, settledUsd, estimatedCost, agent_id);
          return {
            content: [{ type: "text", text: `[${targetModel} | ${fullMessages.length} msgs]\n\n${reply}` }],
            structuredContent: { model_used: targetModel, response: reply, message_count: fullMessages.length },
          };
        } catch (error) {
          return { content: [{ type: "text", text: formatError(extractErrorMessage(error)) }], isError: true };
        }
      }

      // If specific model provided, use it directly
      if (model) {
        try {
          const { result: response, settledUsd } = await withSettledCost(llm, () => llm.chat(model, message, {
            system,
            maxTokens: max_tokens,
            temperature,
            responseFormat,
            stop,
          }));
          recordActualSpend(budget, settledUsd, estimatedCost, agent_id);
          return { content: [{ type: "text", text: response }] };
        } catch (error) {
          return {
            content: [{ type: "text", text: formatError(extractErrorMessage(error)) }],
            isError: true,
          };
        }
      }

      // Smart routing mode
      const routingMode: RoutingMode = mode || "balanced";
      const models = MODEL_TIERS[routingMode];

      let lastError: unknown = null;
      for (const m of models) {
        try {
          const { result: response, settledUsd } = await withSettledCost(llm, () => llm.chat(m, message, {
            system,
            maxTokens: max_tokens,
            temperature,
            responseFormat,
            stop,
          }));
          recordActualSpend(budget, settledUsd, estimatedCost, agent_id);
          return {
            content: [{ type: "text", text: `[${m}]\n\n${response}` }],
            structuredContent: { model_used: m, response },
          };
        } catch (error) {
          lastError = error;
          continue;
        }
      }

      const errorMessage = lastError ? extractErrorMessage(lastError) : "All models failed";
      return {
        content: [{ type: "text", text: formatError(errorMessage) }],
        isError: true,
      };
      } finally {
        gate.release();
      }
    }
  );
}
