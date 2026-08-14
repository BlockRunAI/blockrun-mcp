// src/tools/scrapecheck.ts
//
// ScrapeCheck (scrapecheck.fly.dev) — independent verification of a held web
// value against its live source page. Typed structured tool (not a skill):
// two endpoints, a fixed input contract the LLM should respect, one price
// each. The agent holds a value it got from somewhere else (a search result,
// a scraper, another tool) and needs to know it is on the source page right
// now before acting on it.
//
// Settlement: per call to ScrapeCheck's Base treasury via the gateway
// (route proposed in this PR — see PR description). No API key exists on
// either side: x402 payment is the credential.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TOOL_ANNOTATIONS } from "../tool-annotations.js";
import { z } from "zod";
import { reserveBudget, recordSpending } from "../utils/budget.js";
import { withTxFee } from "../utils/tx-fee.js";
import { asStructuredContent } from "../utils/body.js";
import { getClient } from "../utils/wallet.js";
import { formatError, extractErrorMessage } from "../utils/errors.js";
import type { BudgetState } from "../types.js";

type RawClient = {
  requestWithPaymentRaw: (endpoint: string, body: unknown) => Promise<unknown>;
};

// Base prices published in ScrapeCheck's OpenAPI and charged by its 402
// challenge (verified against the live challenge header, x402 v2):
// /verify $0.01, /verify-presence $0.002. The gateway adds its flat tx fee.
export function estimateScrapecheckCost(tier: string): number {
  return withTxFee(tier === "presence" ? 0.002 : 0.01);
}

export function registerScrapecheckTool(server: McpServer, budget: BudgetState): void {
  server.registerTool(
    "blockrun_scrapecheck",
    {
      description: `Verify a web value you already hold against its live source page (ScrapeCheck). Not retrieval: it checks a value, it does not find data.

Call when a price, title, availability, or any page value came from a search result, a scraper, or another tool, and you are about to act on it. ScrapeCheck independently re-fetches the page and returns a signed pass/fail/unverifiable verdict — a claim is never certified unless the re-fetched page contains it, and anything unconfirmed is unverifiable, never pass. Verdicts are ed25519-signed and verifiable offline.

Tiers:
- verify   — full check: is the value on the page AND does it answer what was asked   ($${withTxFee(0.01).toFixed(3)}/check charged)
- presence — cheap screen: does the value appear on the page at all; never returns pass ($${withTxFee(0.002).toFixed(4)}/check charged)

Scope: server-rendered pages; JS-only content returns unverifiable rather than a guess.`,
      annotations: TOOL_ANNOTATIONS.readOnlyOpenWorld,
      inputSchema: {
        url: z.string().describe("Source page the value came from (public http/https)"),
        claim: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .describe('The value(s) to check, as {field: value}, e.g. {"price": "$45"}'),
        asked: z.string().describe("The question the value is supposed to answer, plain text"),
        tier: z
          .enum(["verify", "presence"])
          .optional()
          .describe('"verify" (default, full check) or "presence" (cheap screen, never returns pass)'),
        agent_id: z.string().optional().describe("Agent identifier for budget tracking and enforcement."),
      },
    },
    async ({ url, claim, asked, tier, agent_id }) => {
      try {
        const chosenTier = tier === "presence" ? "presence" : "verify";
        const estimatedCost = estimateScrapecheckCost(chosenTier);
        const gate = reserveBudget(budget, agent_id, estimatedCost);
        if (!gate.allowed) {
          return {
            content: [{ type: "text", text: `${gate.reason}. Use blockrun_wallet action:"report" to see usage or action:"delegate" to increase agent budget.` }],
            isError: true,
          };
        }
        try {
          const client = getClient() as unknown as RawClient;
          const endpoint = chosenTier === "presence" ? "/v1/scrapecheck/verify-presence" : "/v1/scrapecheck/verify";
          const result = await client.requestWithPaymentRaw(endpoint, { url, claim, asked });
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
