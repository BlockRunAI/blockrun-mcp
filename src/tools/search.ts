// src/tools/search.ts
//
// Grok Live Search — real-time web, X/Twitter, and news search with AI-summarized
// results and citations. Path-based passthrough (one endpoint today, future-proof
// for additional surfaces). Sources, pagination, dates documented in the search
// skill, not the tool description.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { checkBudget, recordSpending } from "../utils/budget.js";
import { getClient } from "../utils/wallet.js";
import { formatError, extractErrorMessage } from "../utils/errors.js";
import type { BudgetState } from "../types.js";

type RawClient = {
  getWithPaymentRaw: (endpoint: string, params?: Record<string, string>) => Promise<unknown>;
  requestWithPaymentRaw: (endpoint: string, body: unknown) => Promise<unknown>;
};

function estimateSearchCost(body: unknown): number {
  if (!body || typeof body !== "object") return 0.075;
  const sources = (body as { sources?: unknown }).sources;
  if (!Array.isArray(sources) || sources.length === 0) return 0.075;
  return 0.025 * sources.length;
}

export function registerSearchTool(server: McpServer, budget: BudgetState): void {
  server.registerTool(
    "blockrun_search",
    {
      description: `Grok Live Search — real-time web + X/Twitter + news with AI-summarized results and citations. ~$0.025 per source.

Common shape:
- body: { query: "...", sources: ["web","x","news"], maxResults: 10, fromDate: "YYYY-MM-DD", toDate: "YYYY-MM-DD" }

\`sources\` accepts any subset of ["web","x","news"] (defaults to all three). For tweet-only searches, use ["x"].

Full request shape + worked examples in the \`search\` skill (\`skills/search/SKILL.md\`).`,
      inputSchema: {
        path: z.string().optional().default("").describe("Endpoint sub-path under /v1/search/ (default empty = root /v1/search). Reserved for future surfaces."),
        body: z.any().optional().describe("Request body. At minimum { query: '...' }. Sent as POST."),
        agent_id: z.string().optional().describe("Agent identifier for budget tracking and enforcement."),
      },
    },
    async ({ path, body, agent_id }) => {
      try {
        const estimatedCost = estimateSearchCost(body);
        const budgetCheck = checkBudget(budget, agent_id, estimatedCost);
        if (!budgetCheck.allowed) {
          return {
            content: [{ type: "text", text: `${budgetCheck.reason}. Use blockrun_wallet action:"report" to see usage or action:"delegate" to increase agent budget.` }],
            isError: true,
          };
        }

        const client = getClient() as unknown as RawClient;
        const cleanPath = (path ?? "").replace(/^\/+/, "").replace(/^v1\/search\/?/, "");
        const endpoint = cleanPath ? `/v1/search/${cleanPath}` : "/v1/search";
        const result = await client.requestWithPaymentRaw(endpoint, body ?? {});
        recordSpending(budget, estimatedCost, agent_id);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result as Record<string, unknown>,
        };
      } catch (err) {
        return { content: [{ type: "text", text: formatError(extractErrorMessage(err)) }], isError: true };
      }
    }
  );
}
