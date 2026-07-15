// src/tools/search.ts
//
// Grok Live Search — real-time web and news search with AI-summarized
// results and citations. Path-based passthrough (one endpoint today, future-proof
// for additional surfaces). Sources, pagination, dates documented in the search
// skill, not the tool description.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { reserveBudget, recordSpending } from "../utils/budget.js";
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
const SEARCH_DEFAULT_MAX_RESULTS = 10;
// The gateway settles 5% above $0.025 × max_results, then rounds UP to 4dp.
// Verified against its own 402 quotes, which are free to request (send any call
// with no payment header): max_results 1/5/10/20/50 quote
// $0.0263/$0.1313/$0.2625/$0.5250/$1.3125. Reserving the unbuffered $0.025 × n
// left the gate short of what the call actually settles at — the exact overshoot
// the reserve exists to prevent.
//
// Integer micro-dollars, because the float form is not exact: 0.025 * 1.05 is
// 0.026250000000000002, which rounds to $0.026251 — still under the gateway's
// $0.0263, i.e. still short. A reserve must never be short.
const SEARCH_MICRO_PER_SOURCE = 26_250; // $0.025 x 1.05, exact in micro-dollars
const SEARCH_MICRO_QUANTUM = 100; // the gateway quotes to 4dp = 100 micro-dollars

export function estimateSearchCost(body: unknown): number {
  const reserve = (max: number) =>
    (Math.ceil((SEARCH_MICRO_PER_SOURCE * max) / SEARCH_MICRO_QUANTUM) * SEARCH_MICRO_QUANTUM) / 1e6;
  if (!body || typeof body !== "object") return reserve(SEARCH_DEFAULT_MAX_RESULTS);
  const raw = (body as { max_results?: unknown }).max_results;
  const max = typeof raw === "number" && raw > 0 ? Math.min(50, Math.floor(raw)) : SEARCH_DEFAULT_MAX_RESULTS;
  return reserve(max);
}

export function registerSearchTool(server: McpServer, budget: BudgetState): void {
  server.registerTool(
    "blockrun_search",
    {
      description: `Grok Live Search — real-time web + X/Twitter + news with AI-summarized results and citations. PRICED PER SOURCE and expensive by default: $0.025 × max_results, +5% gateway buffer — default max_results=10 settles ~$0.26 (max_results=50 → ~$1.31). Pass a smaller max_results to cap spend; for a plain fact, 3 sources (~$0.08) is usually enough.

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
        const cleanPath = (path ?? "").replace(/^\/+/, "").replace(/^v1\/search\/?/, "");
        if (hasPathTraversal(cleanPath)) {
          return { content: [{ type: "text", text: formatError(`Invalid path '${path}'.`) }], isError: true };
        }
        const estimatedCost = estimateSearchCost(body);
        const gate = reserveBudget(budget, agent_id, estimatedCost);
        if (!gate.allowed) {
          return {
            content: [{ type: "text", text: `${gate.reason}. Use blockrun_wallet action:"report" to see usage or action:"delegate" to increase agent budget.` }],
            isError: true,
          };
        }
        try {
          const client = getClient() as unknown as RawClient;
          const endpoint = cleanPath ? `/v1/search/${cleanPath}` : "/v1/search";
          const result = await client.requestWithPaymentRaw(endpoint, body ?? {});
          recordSpending(budget, estimatedCost, agent_id);
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            structuredContent: asStructuredContent(result),
          };
        } finally {
          gate.release();
        }
      } catch (err) {
        return { content: [{ type: "text", text: formatError(extractErrorMessage(err)) }], isError: true };
      }
    }
  );
}
