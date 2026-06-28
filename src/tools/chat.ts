// src/tools/chat.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { LLMClient } from "@blockrun/llm";
import { getClient, getAnthropicClient, baseOnlyMessage } from "../utils/wallet.js";
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
  routing: string | undefined,
  routingProfile: string | undefined,
): number {
  // Free paths bypass the gate entirely.
  if (mode === "free") return 0;
  if (model?.startsWith("nvidia/")) return 0;
  // NOTE: routing_profile:"free" is NOT a free path. @blockrun/llm 2.x dropped
  // the free routing profile, so it maps to undefined → the gateway picks a PAID
  // auto-tier model. Reserving $0 here previously let an agent loop drain the
  // wallet past the cap. It falls through to the smart-routing reserve below.

  const out = Math.max(maxTokens ?? 1024, 256);
  // ~$20 / 1M output tokens — a conservative upper bound covering premium
  // frontier output, floored so tiny completions still reserve something real.
  const frontierReserve = Math.max(0.01, (out / 1_000_000) * 20);

  // Smart routing: cost varies by profile; reserve the worst-case it may settle.
  if (routing === "smart") {
    switch (routingProfile) {
      case "eco":     return 0.01;
      case "premium": return frontierReserve;
      case "auto":
      default:        return Math.max(0.01, frontierReserve * 0.5);
    }
  }

  // Reasoning/powerful tiers and any explicit single model can be a frontier
  // model whose real price we can't know up front — reserve conservatively.
  if (mode === "reasoning" || mode === "powerful") return frontierReserve;
  if (model) return frontierReserve;

  // Heuristic cheap/balanced/coding/glm/fast modes pick budget models.
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
- routing:"smart" → auto-select via ClawRouter

Pick directly: model:"zai/glm-5", model:"openai/o3", model:"nvidia/deepseek-v4-flash" (free).

Run blockrun_models to see all available models with pricing.`,
      inputSchema: {
        message: z.string().describe("Your message to the AI"),
        model: z.string().optional().describe("Specific model ID (e.g., 'zai/glm-5', 'openai/o3')"),
        mode: z.enum(["fast", "balanced", "powerful", "cheap", "reasoning", "free", "coding", "glm"]).optional().describe("Routing mode: glm = Zhipu GLM-5/GLM-5-Turbo ($0.001/call, great for coding), coding = GLM-5 + code models, cheap = GLM-5 + budget, free = NVIDIA only (ignored if model specified)"),
        routing: z.enum(["smart"]).optional().describe('Set to "smart" to auto-select the optimal model via ClawRouter (14-dimension AI routing)'),
        routing_profile: z.enum(["free", "eco", "auto", "premium"]).optional().default("auto").describe('Cost/quality profile for ClawRouter: "eco" (budget), "auto" (balanced, default), "premium" (best quality). Note: "free" maps to "auto" (the SDK dropped the free profile) and still settles a PAID model — for zero-cost generation use mode:"free" or model:"nvidia/...". Only applies when routing:"smart".'),
        system: z.string().optional().describe("Optional system prompt"),
        max_tokens: z.number().optional().default(1024).describe("Max tokens in response"),
        temperature: z.number().optional().default(1).describe("Creativity 0-2"),
        response_format: z.enum(["text", "json_object"]).optional().describe("Set to 'json_object' to force valid JSON output (no markdown fences). Works across all providers."),
        stop: z.array(z.string()).max(4).optional().describe("Up to 4 stop sequences; generation halts when any is produced"),
        thinking: z.object({
          type: z.literal("enabled"),
          budget_tokens: z.number().min(1).describe("Tokens Claude may spend reasoning before answering. max_tokens is auto-raised above this if needed."),
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
    async ({ message, model, mode, routing, routing_profile, system, max_tokens, temperature, response_format, stop, thinking, agent_id, messages }) => {
      const llm = getClient();

      // OpenAI-compatible response shaping, forwarded to every call path below.
      const responseFormat = response_format ? ({ type: response_format } as const) : undefined;

      // Budget gate: global + per-agent enforcement.
      // Smart routing picks the model AFTER the gate, so use a per-profile
      // worst-case estimate so a single premium-profile call cannot blow past
      // a near-exhausted budget. Mode-based heuristics escalate similarly.
      const estimatedCost = estimateChatCost(max_tokens, mode, model, routing, routing_profile);
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

      // ClawRouter smart routing (EVM/Base only)
      if (routing === "smart") {
        // smartChat() takes a single prompt string and cannot carry a `messages`
        // array, so combining the two would silently drop the conversation
        // history. Reject the combination instead of answering without context.
        if (messages && messages.length > 0) {
          return {
            content: [{ type: "text", text: formatError('routing:"smart" does not support multi-turn `messages` — smart routing answers a single prompt. Send the conversation via `messages` with an explicit `model`/`mode` (no routing), or send a single `message` with routing:"smart".') }],
            isError: true,
          };
        }
        if (!(llm instanceof LLMClient)) {
          return {
            content: [{ type: "text", text: "Smart routing (ClawRouter) is not available on Solana. Use a specific model or mode instead." }],
            isError: true,
          };
        }
        try {
          const { result, settledUsd } = await withSettledCost(llm, () => llm.smartChat(message, {
            system,
            maxTokens: max_tokens,
            maxOutputTokens: max_tokens,
            temperature,
            // @blockrun/llm 2.x dropped the "free" routing profile; the gateway
            // already routes to the most cost-effective model by default, so we
            // omit it and let ClawRouter pick (matches the SDK upgrade path).
            routingProfile: routing_profile === "free" ? undefined : routing_profile,
            responseFormat,
            stop,
          }));
          // Book the REAL settled cost (getSpending delta); fall back to
          // ClawRouter's own estimate, then the gate reserve.
          recordActualSpend(budget, settledUsd, result.routing.costEstimate || estimatedCost, agent_id);
          return {
            content: [{ type: "text", text: `[${result.model} | ${result.routing.tier} | $${result.routing.costEstimate.toFixed(4)} | ${Math.round((result.routing.savings ?? 0) * 100)}% savings]\n\n${result.response}` }],
            structuredContent: {
              model_used: result.model,
              response: result.response,
              routing: result.routing,
            },
          };
        } catch (error) {
          return { content: [{ type: "text", text: formatError(extractErrorMessage(error)) }], isError: true };
        }
      }

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
