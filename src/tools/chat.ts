// src/tools/chat.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { LLMClient } from "@blockrun/llm";
import { getClient } from "../utils/wallet.js";
import { formatError } from "../utils/errors.js";
import { MODEL_TIERS, type RoutingMode } from "../utils/constants.js";
import { checkBudget, recordSpending } from "../utils/budget.js";
import type { BudgetState } from "../types.js";

/**
 * Worst-case per-call cost estimate for the budget pre-check. Smart routing
 * doesn't know which model it'll pick until after the call, so we estimate by
 * routing_profile; mode-based paths escalate for reasoning/powerful tiers.
 * The post-call `recordSpending` in the smart path uses the SDK's actual
 * `costEstimate`, so this only needs to be conservative, not precise.
 */
function estimateChatCost(
  mode: string | undefined,
  model: string | undefined,
  routing: string | undefined,
  routingProfile: string | undefined,
): number {
  // Free paths bypass the gate entirely.
  if (mode === "free") return 0;
  if (model?.startsWith("nvidia/")) return 0;
  if (routing === "smart" && routingProfile === "free") return 0;

  // Smart routing: cost varies by profile. Conservative upper-bound so the
  // gate matches what ClawRouter may actually settle.
  if (routing === "smart") {
    switch (routingProfile) {
      case "eco":     return 0.002;
      case "premium": return 0.05;
      case "auto":
      default:        return 0.01;
    }
  }

  // Mode-based: reasoning/powerful tiers pick expensive frontier models.
  if (mode === "reasoning" || mode === "powerful") return 0.01;

  // Default nominal cost for cheap/balanced/coding/glm/fast and explicit
  // single-model calls. Matches the local recordSpending convention.
  return 0.001;
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
- mode:"reasoning" → o3, o1, DeepSeek-R1
- mode:"free" → NVIDIA models (no cost)
- routing:"smart" → auto-select via ClawRouter

Pick directly: model:"zai/glm-5", model:"openai/o3", model:"nvidia/deepseek-v3.2" (free).

Run blockrun_models to see all 41+ models with pricing.`,
      inputSchema: {
        message: z.string().describe("Your message to the AI"),
        model: z.string().optional().describe("Specific model ID (e.g., 'zai/glm-5', 'openai/o3')"),
        mode: z.enum(["fast", "balanced", "powerful", "cheap", "reasoning", "free", "coding", "glm"]).optional().describe("Routing mode: glm = Zhipu GLM-5/GLM-5-Turbo ($0.001/call, great for coding), coding = GLM-5 + code models, cheap = GLM-5 + budget, free = NVIDIA only (ignored if model specified)"),
        routing: z.enum(["smart"]).optional().describe('Set to "smart" to auto-select the optimal model via ClawRouter (14-dimension AI routing)'),
        routing_profile: z.enum(["free", "eco", "auto", "premium"]).optional().default("auto").describe('Cost/quality profile for ClawRouter: "free" (zero cost NVIDIA), "eco" (budget), "auto" (balanced, default), "premium" (best quality) (only applies when routing: "smart")'),
        system: z.string().optional().describe("Optional system prompt"),
        max_tokens: z.number().optional().default(1024).describe("Max tokens in response"),
        temperature: z.number().optional().default(1).describe("Creativity 0-2"),
        response_format: z.enum(["text", "json_object"]).optional().describe("Set to 'json_object' to force valid JSON output (no markdown fences). Works across all providers."),
        stop: z.array(z.string()).max(4).optional().describe("Up to 4 stop sequences; generation halts when any is produced"),
        agent_id: z.string().optional().describe("Agent identifier. If a budget was delegated for this agent_id via blockrun_wallet action:'delegate', spending is tracked and enforced. The agent is hard-stopped when its budget is exhausted."),
        messages: z.array(z.object({
          role: z.enum(["user", "assistant", "system"]),
          content: z.string(),
        })).optional().describe("Conversation history for multi-turn context. When provided, 'message' is appended as the final user turn. Use with explicit 'model' param (defaults to 'openai/gpt-5.4' if not specified). Note: if you include a role:'system' entry in messages[], do not also pass the system param to avoid duplicate system messages."),
      },
    },
    async ({ message, model, mode, routing, routing_profile, system, max_tokens, temperature, response_format, stop, agent_id, messages }) => {
      const llm = getClient();

      // OpenAI-compatible response shaping, forwarded to every call path below.
      const responseFormat = response_format ? ({ type: response_format } as const) : undefined;

      // Budget gate: global + per-agent enforcement.
      // Smart routing picks the model AFTER the gate, so use a per-profile
      // worst-case estimate so a single premium-profile call cannot blow past
      // a near-exhausted budget. Mode-based heuristics escalate similarly.
      const estimatedCost = estimateChatCost(mode, model, routing, routing_profile);
      const budgetCheck = checkBudget(budget, agent_id, estimatedCost);
      if (!budgetCheck.allowed) {
        return {
          content: [{ type: "text", text: `${budgetCheck.reason}. Use blockrun_wallet with action: "report" to see usage, or action: "delegate" to increase agent budget.` }],
          isError: true,
        };
      }

      // ClawRouter smart routing (EVM/Base only)
      if (routing === "smart") {
        if (!(llm instanceof LLMClient)) {
          return {
            content: [{ type: "text", text: "Smart routing (ClawRouter) is not available on Solana. Use a specific model or mode instead." }],
            isError: true,
          };
        }
        try {
          const result = await llm.smartChat(message, {
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
          });
          // Record cost from ClawRouter's estimate
          recordSpending(budget, result.routing.costEstimate || 0.001, agent_id);
          return {
            content: [{ type: "text", text: `[${result.model} | ${result.routing.tier} | $${result.routing.costEstimate.toFixed(4)} | ${Math.round((result.routing.savings ?? 0) * 100)}% savings]\n\n${result.response}` }],
            structuredContent: {
              model_used: result.model,
              response: result.response,
              routing: result.routing,
            },
          };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          return { content: [{ type: "text", text: formatError(errorMessage) }], isError: true };
        }
      }

      // Multi-turn conversation
      if (messages && messages.length > 0) {
        const targetModel = model || MODEL_TIERS[(mode ?? "balanced") as RoutingMode]?.[0] || "openai/gpt-5.4";
        const fullMessages = [
          ...(system ? [{ role: "system" as const, content: system }] : []),
          ...messages,
          { role: "user" as const, content: message },
        ];
        try {
          const result = await llm.chatCompletion(targetModel, fullMessages, {
            maxTokens: max_tokens,
            temperature,
            responseFormat,
            stop,
          });
          const reply = result.choices?.[0]?.message?.content || "";
          recordSpending(budget, estimatedCost, agent_id); // local estimate
          return {
            content: [{ type: "text", text: `[${targetModel} | ${fullMessages.length} msgs]\n\n${reply}` }],
            structuredContent: { model_used: targetModel, response: reply, message_count: fullMessages.length },
          };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          return { content: [{ type: "text", text: formatError(errorMessage) }], isError: true };
        }
      }

      // If specific model provided, use it directly
      if (model) {
        try {
          const response = await llm.chat(model, message, {
            system,
            maxTokens: max_tokens,
            temperature,
            responseFormat,
            stop,
          });
          recordSpending(budget, estimatedCost, agent_id); // local estimate
          return { content: [{ type: "text", text: response }] };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          return {
            content: [{ type: "text", text: formatError(errorMessage) }],
            isError: true,
          };
        }
      }

      // Smart routing mode
      const routingMode: RoutingMode = mode || "balanced";
      const models = MODEL_TIERS[routingMode];

      let lastError: Error | null = null;
      for (const m of models) {
        try {
          const response = await llm.chat(m, message, {
            system,
            maxTokens: max_tokens,
            temperature,
            responseFormat,
            stop,
          });
          recordSpending(budget, estimatedCost, agent_id); // local estimate
          return {
            content: [{ type: "text", text: `[${m}]\n\n${response}` }],
            structuredContent: { model_used: m, response },
          };
        } catch (error) {
          lastError = error as Error;
          continue;
        }
      }

      const errorMessage = lastError?.message || "All models failed";
      return {
        content: [{ type: "text", text: formatError(errorMessage) }],
        isError: true,
      };
    }
  );
}
