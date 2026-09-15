// src/tools/exa.ts
//
// Exa neural web search — path-based passthrough. Full action catalog
// (search / answer / contents / find-similar) lives in the exa-research skill,
// not the tool description.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TOOL_ANNOTATIONS } from "../tool-annotations.js";
import { z } from "zod";
import { reserveBudget, recordSpending, recordActualSpend } from "../utils/budget.js";
import { confirmSpend } from "../utils/confirm-spend.js";
import { withTxFee } from "../utils/tx-fee.js";
import { asStructuredContent, coerceBody } from "../utils/body.js";
import { buildClient } from "../utils/wallet.js";
import { ledgerFallback, rawPost, type RawClient } from "../utils/raw-call.js";
import { formatError } from "../utils/errors.js";
import { pathToolFailure } from "../utils/path-tool-catch.js";
import { hasPathTraversal, normalizeClassifyPath } from "../utils/path-safety.js";
import type { BudgetState } from "../types.js";


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
- search       — body: { query, numResults?, category?, includeDomains?, excludeDomains? }   ($0.010 base + tx fee)
- answer       — body: { query }                                                              ($0.010 base + tx fee)
- contents     — body: { urls: [...] }                                                        ($0.002/URL + ONE tx fee, up to 100)
- find-similar — body: { url, numResults? }                                                   ($0.010 base + tx fee)
Tx fee = the gateway's flat network fee, $0.001 today (we reserve $0.002); the 402 header carries the exact charge.

Categories for search: "news", "research paper", "company", "tweet", "github", "pdf".

Full request/response shapes + worked research workflows in the \`exa-research\` skill.`,
      annotations: TOOL_ANNOTATIONS.readOnlyOpenWorld,
      inputSchema: {
        path: z.string().describe("Endpoint name under /v1/exa/, e.g. 'search', 'answer', 'contents', 'find-similar'"),
        body: z.any().optional().describe("JSON body for the call. Sent as POST. Required for all four endpoints."),
        agent_id: z.string().optional().describe("Agent identifier for budget tracking and enforcement."),
      },
    },
    async ({ path, body, agent_id }) => {
      // The reserve of the paid request in flight, for the catch: 0 until the
      // line before rawPost, so nothing thrown earlier can book a charge.
      let sentUsd = 0;
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
          // Human-in-the-loop (BLOCKRUN_CONFIRM_SPEND=on): ask before signing. A
          // decline returns here — nothing is sent, and the finally releases the
          // reservation. No-ops when off, sub-threshold, or unsupported by the client.
          const confirm = await confirmSpend(server, { usd: estimatedCost, label: `exa · ${cleanPath}` });
          if (!confirm.ok) return { content: [{ type: "text", text: confirm.reason ?? "Charge cancelled." }] };
          // A FRESH client per call, never the shared singleton: rawGet/rawPost
          // read the SDK's cumulative spend counter around the call to tell a
          // settled-then-failed request from a free refusal, and the MCP SDK
          // dispatches tool calls concurrently — on a shared client a
          // concurrent call's settlement landed inside this call's window and
          // was booked to it as "the charge stands" (audit round 4b). Same
          // reason blockrun_chat builds its own.
          const client = buildClient() as unknown as RawClient;
          const endpoint = `/v1/exa/${cleanPath}`;
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
        // Books the reserve when the payment went out and no origin answer came
        // back (utils/path-tool-catch.ts). replayUpstream: the gateway's exa
        // route answers an Exa 5xx with "Payment was NOT charged" WITHOUT
        // releasing the payment nonce, so on Base the SDK's same-header retry
        // is refused as a replay and surfaces as the SDK's "Payment was
        // rejected. Check your wallet balance." — the hedge in utils/errors.ts
        // adds that second reading on Base only.
        return pathToolFailure(err, { budget, agentId: agent_id, sentUsd, replayUpstream: "Exa" });
      }
    }
  );
}
