// src/tools/exa.ts
//
// Exa neural web search — path-based passthrough. Full action catalog
// (search / answer / contents / find-similar) lives in the exa-research skill,
// not the tool description.

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

function estimateExaCost(path: string, body: unknown): number {
  const cleanPath = path.replace(/^\/+/, "").replace(/^v1\/exa\//, "");
  if (cleanPath === "contents") {
    const urls = body && typeof body === "object" ? (body as { urls?: unknown }).urls : undefined;
    return 0.002 * (Array.isArray(urls) && urls.length > 0 ? urls.length : 1);
  }
  return 0.01;
}

export function registerExaTool(server: McpServer, budget: BudgetState): void {
  server.registerTool(
    "blockrun_exa",
    {
      description: `Neural web search via Exa — understands meaning, not just keywords. Great for research.

Common paths (all POST, body shapes documented in the exa-research skill):
- search       — body: { query, numResults?, category?, includeDomains?, excludeDomains? }   ($0.01/call)
- answer       — body: { query }                                                              ($0.01/call)
- contents     — body: { urls: [...] }                                                        ($0.002/URL, up to 100)
- find-similar — body: { url, numResults? }                                                   ($0.01/call)

Categories for search: "news", "research paper", "company", "tweet", "github", "pdf".

Full request/response shapes + worked research workflows in the \`exa-research\` skill.`,
      inputSchema: {
        path: z.string().describe("Endpoint name under /v1/exa/, e.g. 'search', 'answer', 'contents', 'find-similar'"),
        body: z.any().optional().describe("JSON body for the call. Sent as POST. Required for all four endpoints."),
        agent_id: z.string().optional().describe("Agent identifier for budget tracking and enforcement."),
      },
    },
    async ({ path, body, agent_id }) => {
      try {
        body = coerceBody(body);
        const estimatedCost = estimateExaCost(path, body);
        const budgetCheck = checkBudget(budget, agent_id, estimatedCost);
        if (!budgetCheck.allowed) {
          return {
            content: [{ type: "text", text: `${budgetCheck.reason}. Use blockrun_wallet action:"report" to see usage or action:"delegate" to increase agent budget.` }],
            isError: true,
          };
        }

        const cleanPath = path.replace(/^\/+/, "").replace(/^v1\/exa\//, "");
        if (hasPathTraversal(cleanPath)) {
          return { content: [{ type: "text", text: formatError(`Invalid path '${path}'.`) }], isError: true };
        }
        const client = getClient() as unknown as RawClient;
        const endpoint = `/v1/exa/${cleanPath}`;
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
