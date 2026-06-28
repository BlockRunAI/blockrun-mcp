// src/tools/search.ts
//
// Grok Live Search — real-time web, X/Twitter, and news search with AI-summarized
// results and citations. Path-based passthrough (one endpoint today, future-proof
// for additional surfaces). Sources, pagination, dates documented in the search
// skill, not the tool description.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { checkBudget, recordSpending } from "../utils/budget.js";
import { asStructuredContent, coerceBody } from "../utils/body.js";
import { getClient } from "../utils/wallet.js";
import { formatError, extractErrorMessage } from "../utils/errors.js";
import { hasPathTraversal } from "../utils/path-safety.js";
import type { BudgetState } from "../types.js";

type RawClient = {
  getWithPaymentRaw: (endpoint: string, params?: Record<string, string>) => Promise<unknown>;
  requestWithPaymentRaw: (endpoint: string, body: unknown) => Promise<unknown>;
};

// Pricing scales with max_results (capped 1–50, default 10 upstream) at
// $0.025 per returned source. Mirrors getSearchPrice() in
// blockrun/src/app/api/v1/search/route.ts.
const SEARCH_PRICE_PER_SOURCE = 0.025;
const SEARCH_DEFAULT_MAX_RESULTS = 10;

function estimateSearchCost(body: unknown): number {
  if (!body || typeof body !== "object") return SEARCH_PRICE_PER_SOURCE * SEARCH_DEFAULT_MAX_RESULTS;
  const raw = (body as { max_results?: unknown }).max_results;
  const max = typeof raw === "number" && raw > 0 ? Math.min(50, Math.floor(raw)) : SEARCH_DEFAULT_MAX_RESULTS;
  return SEARCH_PRICE_PER_SOURCE * max;
}

export function registerSearchTool(server: McpServer, budget: BudgetState): void {
  server.registerTool(
    "blockrun_search",
    {
      description: `Grok Live Search — real-time web + X/Twitter + news with AI-summarized results and citations. $0.025 per returned source (max_results × $0.025; default max_results=10 → $0.25).

Common shape:
- body: { query: "...", sources: ["web","x","news"], max_results: 10, from_date: "YYYY-MM-DD", to_date: "YYYY-MM-DD" }

\`sources\` accepts any subset of ["web","x","news"] (defaults to all three). For tweet-only searches, use ["x"]. \`max_results\` is 1–50 (default 10) and drives the price — pass a smaller value if you want to cap spend.

Full request shape + worked examples in the \`search\` skill (\`skills/search/SKILL.md\`).`,
      inputSchema: {
        path: z.string().optional().default("").describe("Endpoint sub-path under /v1/search/ (default empty = root /v1/search). Reserved for future surfaces."),
        body: z.any().optional().describe("Request body. At minimum { query: '...' }. Sent as POST."),
        agent_id: z.string().optional().describe("Agent identifier for budget tracking and enforcement."),
      },
    },
    async ({ path, body, agent_id }) => {
      try {
        body = coerceBody(body);
        const estimatedCost = estimateSearchCost(body);
        const budgetCheck = checkBudget(budget, agent_id, estimatedCost);
        if (!budgetCheck.allowed) {
          return {
            content: [{ type: "text", text: `${budgetCheck.reason}. Use blockrun_wallet action:"report" to see usage or action:"delegate" to increase agent budget.` }],
            isError: true,
          };
        }

        const cleanPath = (path ?? "").replace(/^\/+/, "").replace(/^v1\/search\/?/, "");
        if (hasPathTraversal(cleanPath)) {
          return { content: [{ type: "text", text: formatError(`Invalid path '${path}'.`) }], isError: true };
        }
        const client = getClient() as unknown as RawClient;
        const endpoint = cleanPath ? `/v1/search/${cleanPath}` : "/v1/search";
        const result = await client.requestWithPaymentRaw(endpoint, body ?? {});
        recordSpending(budget, estimatedCost, agent_id);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: asStructuredContent(result),
        };
      } catch (err) {
        return { content: [{ type: "text", text: formatError(extractErrorMessage(err)) }], isError: true };
      }
    }
  );
}
