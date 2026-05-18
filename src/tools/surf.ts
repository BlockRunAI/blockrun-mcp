// src/tools/surf.ts
//
// Surf (asksurf.ai) — unified crypto data API. Path-based passthrough so the
// 84-endpoint catalog stays out of the tool description (it lives in the surf
// skill instead). Adding new Surf endpoints does not require an MCP release.
//
// Mirrors the markets.ts pattern. Method is inferred: pass `body` for POST
// (onchain/query, onchain/sql, chat/completions), otherwise GET with `params`.
//
// Settlement: each call settles directly to Surf's Base treasury. BlockRun
// forwards the request server-side using the BlockRun-held SURF_API_KEY.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { checkBudget, recordSpending } from "../utils/budget.js";
import { getClient } from "../utils/wallet.js";
import { formatError, extractErrorMessage } from "../utils/errors.js";
import type { BudgetState } from "../types.js";

type SurfClient = {
  getWithPaymentRaw: (endpoint: string, params?: Record<string, string>) => Promise<unknown>;
  requestWithPaymentRaw: (endpoint: string, body: unknown) => Promise<unknown>;
};

function estimateSurfCost(path: string): number {
  const p = path.toLowerCase();
  if (p.includes("onchain/sql") || p.includes("onchain/query") || p.includes("chat/completions")) return 0.02;
  if (
    p.includes("search/") ||
    p.includes("wallet/detail") ||
    p.includes("social/mindshare") ||
    p.includes("orderbook") ||
    p.includes("candles")
  ) {
    return 0.005;
  }
  return 0.001;
}

export function registerSurfTool(server: McpServer, budget: BudgetState): void {
  server.registerTool(
    "blockrun_surf",
    {
      description: `Unified crypto data via Surf (asksurf.ai) — 84 endpoints, one API.

Coverage: CEX market data (16 exchanges), on-chain SQL across 13 chains, 100M+ labeled wallets, prediction markets (Polymarket + Kalshi), social mindshare / CT intelligence, news, unified search, and Surf-1.5 chat with citations.

Pricing (settled in USDC to Surf's Base treasury):
- Tier 1 $0.001 — prices, rankings, lists, news, profiles, simple reads
- Tier 2 $0.005 — order books, candles, search, wallet detail, social aggregates
- Tier 3 $0.020 — raw on-chain SQL, structured queries, surf-1.5 chat

Common paths (full 84-endpoint catalog in the surf skill):
- market/price?symbol=BTC                     (T1)
- exchange/price?pair=BTC-USDT                (T1)
- prediction-market/polymarket/ranking         (T1)
- search/web?q=ethereum+pectra+upgrade        (T2)
- wallet/detail?address=0x...                 (T2)
- social/mindshare?q=ethereum&interval=1d     (T2)
- onchain/sql        + body:{ sql: "SELECT ..." }                  (T3)
- chat/completions   + body:{ model:"surf/surf-1.5", messages:[]}  (T3, $0.02 flat)

Method is auto-routed: pass 'body' for POST endpoints; otherwise GET with 'params'.
Each Surf endpoint pre-validates required params before settling — you get a 400 (not a charge) if a required field is missing. Browse the full catalog: https://blockrun.ai/marketplace/surf`,
      inputSchema: {
        path: z.string().describe("Endpoint path under /v1/surf/, e.g. 'market/price', 'prediction-market/polymarket/ranking', 'wallet/detail', 'onchain/sql', 'chat/completions'"),
        params: z.record(z.string(), z.string()).optional().describe("Query parameters for GET endpoints, e.g. { symbol: 'BTC' } or { address: '0x...', chain: 'ethereum' }"),
        body: z.any().optional().describe("JSON body for POST endpoints. Provide for: onchain/query, onchain/sql, chat/completions. When set, the call is sent as POST; otherwise GET with params."),
        agent_id: z.string().optional().describe("Agent identifier for budget tracking and enforcement."),
      },
    },
    async ({ path, params, body, agent_id }) => {
      try {
        const cleanPath = path.replace(/^\/+/, "").replace(/^v1\/surf\//, "").replace(/^api\/v1\/surf\//, "");
        const estimatedCost = estimateSurfCost(cleanPath);
        const budgetCheck = checkBudget(budget, agent_id, estimatedCost);
        if (!budgetCheck.allowed) {
          return {
            content: [{ type: "text", text: `${budgetCheck.reason}. Use blockrun_wallet action:"report" to see usage or action:"delegate" to increase agent budget.` }],
            isError: true,
          };
        }

        const client = getClient() as unknown as SurfClient;
        const endpoint = `/v1/surf/${cleanPath}`;
        const result = body !== undefined
          ? await client.requestWithPaymentRaw(endpoint, body)
          : await client.getWithPaymentRaw(endpoint, params);
        recordSpending(budget, estimatedCost, agent_id);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result as Record<string, unknown>,
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: formatError(extractErrorMessage(err)) }],
          isError: true,
        };
      }
    }
  );
}
