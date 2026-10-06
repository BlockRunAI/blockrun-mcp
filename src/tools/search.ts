// src/tools/search.ts
//
// Grok Live Search — real-time web and news search with AI-summarized
// results and citations. Path-based passthrough (one endpoint today, future-proof
// for additional surfaces). Sources, pagination, dates documented in the search
// skill, not the tool description.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TOOL_ANNOTATIONS } from "../tool-annotations.js";
import { z } from "zod";
import { reserveBudget, recordSpending, recordActualSpend } from "../utils/budget.js";
import { confirmSpend } from "../utils/confirm-spend.js";
import { asStructuredContent, coerceBody } from "../utils/body.js";
import { buildClient } from "../utils/wallet.js";
import { ledgerFallback, rawPost, type RawClient } from "../utils/raw-call.js";
import { formatError } from "../utils/errors.js";
import { withTxFee } from "../utils/tx-fee.js";
import { pathToolFailure } from "../utils/path-tool-catch.js";
import { hasPathTraversal } from "../utils/path-safety.js";
import type { BudgetState } from "../types.js";


// One flat price per call: $0.08 base + the transaction fee, whatever
// max_results is. Mirrors SEARCH_PRICE_PER_CALL_USD in blockrun/src/lib/models.ts
// (repriced 2026-09-29 — xAI never sees the count, so the count never drove
// cost). Live 402 quotes 2026-10-06, `amount` in the payment requirement:
// Base 81000 (= $0.081) and Solana 80000 at max_results 1, 10 and 50 alike.
// The old $0.025 x max_results reserve over-reserved the default call 3x and
// a 50-source call 16x, blocking searches a budget could afford.
const SEARCH_BASE_USD = 0.08;

export function estimateSearchCost(_body?: unknown): number {
  return withTxFee(SEARCH_BASE_USD);
}

// The gateway's `sources` enum. X/Twitter was dropped upstream on 2026-07-05
// (blockrun commit edefa8eb, `z.array(z.enum(["web","news"])).optional()
// .default(["web"])`) and this tool went on advertising `["web","x","news"]`
// as its Common shape for two months. Following it to the letter reserved
// $0.2645, sat through the confirm dialog and came back as `API error: 400 /
// Invalid request body` — the SDK strips the zod issues, so the field was
// never named and the agent had no way to self-correct. Unpaid probe
// 2026-09-13: `["web","x","news"]` 400s on both gateways, `["web","news"]`
// quotes a 402. Only the NAMES are ours to check; a non-array `sources` is a
// shape error the gateway reports unpaid.
const SEARCH_SOURCES = ["web", "news"] as const;

/** The refusal for a `sources` entry the gateway no longer serves, or null. Pinned directly in test/search-sources.test.ts. */
export function unsupportedSearchSource(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const sources = (body as { sources?: unknown }).sources;
  if (!Array.isArray(sources)) return null;
  const bad = sources.filter((s) => !(SEARCH_SOURCES as readonly unknown[]).includes(s));
  if (bad.length === 0) return null;
  const xTwitter = bad.some((s) => typeof s === "string" && /^(x|twitter)$/i.test(s));
  return `body.sources ${JSON.stringify(bad)} is not served: the gateway accepts only ["web","news"] (default ["web"]). ` +
    (xTwitter
      ? `The X/Twitter source was removed upstream on 2026-07-05 and there is no live X route in this server — do not retry with "x". `
      : "") +
    `Retry with sources: ["web","news"] or omit it. No payment was made.`;
}

export function registerSearchTool(server: McpServer, budget: BudgetState): void {
  server.registerTool(
    "blockrun_search",
    {
      description: `Grok Live Search — real-time web + news with AI-summarized results and citations. Flat $0.08 per call plus the gateway's network fee ($0.001 on Base today, none on Solana; we reserve $0.002) — the same price at any max_results, so ask for as many sources as the question needs.

Common shape:
- body: { query: "...", sources: ["web","news"], max_results: 10, from_date: "YYYY-MM-DD", to_date: "YYYY-MM-DD" }

\`sources\` accepts any subset of ["web","news"] (default ["web"] — pass both for news coverage). There is no X/Twitter source (removed upstream 2026-07-05; asking for it is refused before payment). \`max_results\` is 1–50 (default 10); it does not change the price.

Full request shape + worked examples in the \`search\` skill (\`skills/search/SKILL.md\`).`,
      annotations: TOOL_ANNOTATIONS.readOnlyOpenWorld,
      inputSchema: {
        path: z.string().optional().default("").describe("Endpoint sub-path under /v1/search/ (default empty = root /v1/search). Reserved for future surfaces."),
        body: z.any().optional().describe("Request body. At minimum { query: '...' }. Sent as POST."),
        agent_id: z.string().optional().describe("Agent identifier for budget tracking and enforcement."),
      },
    },
    async ({ path, body, agent_id }) => {
      // The reserve of the paid request in flight, for the catch: 0 until the
      // line before rawPost, so nothing thrown earlier can book a charge.
      let sentUsd = 0;
      try {
        body = coerceBody(body);
        const cleanPath = (path ?? "").replace(/^\/+/, "").replace(/^v1\/search\/?/, "");
        if (hasPathTraversal(cleanPath)) {
          return { content: [{ type: "text", text: formatError(`Invalid path '${path}'.`) }], isError: true };
        }
        // Before the reserve and the confirm dialog: a source the gateway no
        // longer serves would 400 unpaid anyway, but as an opaque "Invalid
        // request body" — name the field and the live values instead.
        const badSource = unsupportedSearchSource(body);
        if (badSource) {
          return { content: [{ type: "text", text: formatError(badSource) }], isError: true };
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
          // Human-in-the-loop (BLOCKRUN_CONFIRM_SPEND=on): ask before signing. A
          // decline returns here — nothing is sent, and the finally releases the
          // reservation. No-ops when off, sub-threshold, or unsupported by the client.
          const confirm = await confirmSpend(server, { usd: estimatedCost, label: `search · ${cleanPath || "search"}` });
          if (!confirm.ok) return { content: [{ type: "text", text: confirm.reason ?? "Charge cancelled." }] };
          // A FRESH client per call, never the shared singleton: rawGet/rawPost
          // read the SDK's cumulative spend counter around the call to tell a
          // settled-then-failed request from a free refusal, and the MCP SDK
          // dispatches tool calls concurrently — on a shared client a
          // concurrent call's settlement landed inside this call's window and
          // was booked to it as "the charge stands" (audit round 4b). Same
          // reason blockrun_chat builds its own.
          const client = buildClient() as unknown as RawClient;
          const endpoint = cleanPath ? `/v1/search/${cleanPath}` : "/v1/search";
          sentUsd = estimatedCost;
          const { data: result, paidUsd } = await rawPost(client, endpoint, body ?? {});
          recordActualSpend(budget, paidUsd, ledgerFallback(estimatedCost), agent_id);
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            structuredContent: asStructuredContent(result),
          };
        } finally {
          gate.release();
        }
      } catch (err) {
        // Books the reserve only when the payment went out and no ORIGIN answer
        // came back (utils/path-tool-catch.ts). The search route calls Grok
        // BEFORE it settles, so its bare 500 is pre-settle and books nothing.
        return pathToolFailure(err, { budget, agentId: agent_id, sentUsd });
      }
    }
  );
}
