// src/tools/exa.ts
//
// Exa neural web search — path-based passthrough. Full action catalog
// (search / answer / contents / find-similar) lives in the exa-research skill,
// not the tool description.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { reserveBudget, recordSpending } from "../utils/budget.js";
import { withTxFee } from "../utils/tx-fee.js";
import { asStructuredContent, coerceBody } from "../utils/body.js";
import { getClient } from "../utils/wallet.js";
import { formatError, extractErrorMessage } from "../utils/errors.js";
import { hasPathTraversal, normalizeClassifyPath } from "../utils/path-safety.js";
import type { BudgetState } from "../types.js";

type RawClient = {
  getWithPaymentRaw: (endpoint: string, params?: Record<string, string>) => Promise<unknown>;
  requestWithPaymentRaw: (endpoint: string, body: unknown) => Promise<unknown>;
};

export function estimateExaCost(path: string, body: unknown): number {
  // normalizeClassifyPath strips the query string and fragment BEFORE matching.
  // Without it this compared the raw slug, so `contents?x=1` missed the
  // per-URL branch and fell through to the flat $0.01 — while the gateway
  // ignores the query when routing and still billed per URL. 100 URLs reserved
  // $0.012 and settled $0.202, a 17x under-reserve that recordSpending then
  // books wrong permanently. The path is caller-supplied, so a hallucinated or
  // injected `?` was all it took.
  const cleanPath = normalizeClassifyPath(path).replace(/^v1\/exa\//, "");
  if (cleanPath === "contents") {
    const urls = body && typeof body === "object" ? (body as { urls?: unknown }).urls : undefined;
    // One flat fee per REQUEST, not per URL — the gateway adds it once to the
    // whole priced call (see addTransactionFee in the gateway's lib/models.ts).
    return withTxFee(0.002 * (Array.isArray(urls) && urls.length > 0 ? urls.length : 1));
  }
  // Verified live: exa/search charged $0.0120 against a $0.010 base.
  return withTxFee(0.01);
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
        const cleanPath = path.replace(/^\/+/, "").replace(/^v1\/exa\//, "");
        if (hasPathTraversal(cleanPath)) {
          return { content: [{ type: "text", text: formatError(`Invalid path '${path}'.`) }], isError: true };
        }
        const estimatedCost = estimateExaCost(path, body);
        const gate = reserveBudget(budget, agent_id, estimatedCost);
        if (!gate.allowed) {
          return {
            content: [{ type: "text", text: `${gate.reason}. Use blockrun_wallet action:"report" to see usage or action:"delegate" to increase agent budget.` }],
            isError: true,
          };
        }
        try {
          const client = getClient() as unknown as RawClient;
          const endpoint = `/v1/exa/${cleanPath}`;
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
