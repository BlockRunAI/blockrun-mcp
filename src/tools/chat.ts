// src/tools/chat.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { LLMClient } from "@blockrun/llm";
import { getClient } from "../utils/wallet.js";
import { formatError } from "../utils/errors.js";
import { MODEL_TIERS, type RoutingMode } from "../utils/constants.js";
import { checkBudget, recordSpending } from "../utils/budget.js";
import type { BudgetState } from "../types.js";

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
        agent_id: z.string().optional().describe("Agent identifier. If a budget was delegated for this agent_id via blockrun_wallet action:'delegate', spending is tracked and enforced. The agent is hard-stopped when its budget is exhausted."),
        messages: z.array(z.object({
          role: z.enum(["user", "assistant", "system"]),
          content: z.string(),
        })).optional().describe("Conversation history for multi-turn context. When provided, 'message' is appended as the final user turn. Use with explicit 'model' param (defaults to 'openai/gpt-5.4' if not specified). Note: if you include a role:'system' entry in messages[], do not also pass the system param to avoid duplicate system messages."),
      },
    },
    async ({ message, model, mode, routing, routing_profile, system, max_tokens, temperature, agent_id, messages }) => {
      const llm = getClient();

      // Budget gate: global + per-agent enforcement
      const estimatedCost =
        (routing === "smart" && routing_profile === "free") || mode === "free" || model?.startsWith("nvidia/")
          ? 0
          : 0.001;
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
            routingProfile: routing_profile,
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
