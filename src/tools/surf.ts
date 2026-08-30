// src/tools/surf.ts
//
// Surf (asksurf.ai) — unified crypto data API. Path-based passthrough so the
// 83-endpoint catalog stays out of the tool description (it lives in the surf
// skill instead). Adding new Surf endpoints does not require an MCP release.
//
// Mirrors the markets.ts pattern. Method is inferred: pass `body` for POST
// (onchain/query, onchain/sql), otherwise GET with `params`.
//
// Settlement: each call settles directly to Surf's Base treasury. BlockRun
// forwards the request server-side using the BlockRun-held SURF_API_KEY.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TOOL_ANNOTATIONS } from "../tool-annotations.js";
import { z } from "zod";
import { reserveBudget, recordSpending } from "../utils/budget.js";
import { confirmSpend } from "../utils/confirm-spend.js";
import { asStructuredContent, coerceBody } from "../utils/body.js";
import { getClient } from "../utils/wallet.js";
import { formatError, extractErrorMessage } from "../utils/errors.js";
import { hasPathTraversal } from "../utils/path-safety.js";
import type { BudgetState } from "../types.js";

type SurfClient = {
  getWithPaymentRaw: (endpoint: string, params?: Record<string, string>) => Promise<unknown>;
  requestWithPaymentRaw: (endpoint: string, body: unknown) => Promise<unknown>;
};

// Flat per-call price CHARGED for every Surf endpoint: $0.0075 base + $0.002
// flat transaction fee. Keep in step with SURF_TIER_*_PRICE in the gateway's
// src/lib/surf.ts, and note that constant is the BASE — not what a caller pays.
export const SURF_PRICE_USD = 0.0095;

// Exported for unit tests.
//
// Surf is a FLAT $0.0095/call — every endpoint, every former tier (gateway change
// 2026-07-15: one network-uniform price across Surf and Predexon). The old T1/T2/T3
// tier sets are gone: they no longer affect price, and keeping them here only
// invited the reader to believe otherwise. Verified live across every tier —
// market/price, wallet/detail and onchain/sql all quote 9500 micro.
//
// This estimator feeds the BUDGET GATE, so it must never under-quote — and the
// number to quote is what x402 CHARGES, not the 402's JSON `price` field. That
// field reports the base ($0.0075); the charge is in `maxAmountRequired` inside
// the base64 `payment-required` header, and every /v1/surf/* route decodes to
// 9500 micro = $0.0095 (verified live 2026-07-15).
//
// This has now been wrong twice in the same direction, both times by trusting a
// number that looked authoritative: first the stale $0.001/$0.005/$0.02 tiers
// after the gateway went flat, then the $0.0075 base after it was mistaken for
// the price. Read the header.
export function estimateSurfCost(_path: string): number {
  return SURF_PRICE_USD;
}

export function registerSurfTool(server: McpServer, budget: BudgetState): void {
  server.registerTool(
    "blockrun_surf",
    {
      description: `Unified crypto data via Surf (asksurf.ai) — 83 endpoints, one API.

Coverage: CEX market data (16 exchanges), on-chain SQL across 13 chains, 100M+ labeled wallets, prediction markets (Polymarket + Kalshi), social mindshare / CT intelligence, news, and unified search.

Pricing (settled in USDC to Surf's Base treasury):
- Flat $0.0095/call — every endpoint, including raw on-chain SQL. No tiers. ($0.0075 base + $0.002 tx fee.)

Common paths (full 83-endpoint catalog in the surf skill):
- market/price?symbol=BTC
- exchange/price?pair=BTC-USDT
- prediction-market/polymarket/ranking
- search/web?q=ethereum+pectra+upgrade
- wallet/detail?address=0x...
- social/mindshare?q=ethereum&interval=1d
- onchain/sql        + body:{ sql: "SELECT ..." }

Method is auto-routed: pass 'body' for POST endpoints; otherwise GET with 'params'.
Each Surf endpoint pre-validates required params before settling — you get a 400 (not a charge) if a required field is missing. Browse the full catalog: https://blockrun.ai/marketplace/surf`,
      annotations: TOOL_ANNOTATIONS.readOnlyOpenWorld,
      inputSchema: {
        path: z.string().describe("Endpoint path under /v1/surf/, e.g. 'market/price', 'prediction-market/polymarket/ranking', 'wallet/detail', 'onchain/sql'"),
        params: z.record(z.string(), z.string()).optional().describe("Query parameters for GET endpoints, e.g. { symbol: 'BTC' } or { address: '0x...', chain: 'ethereum' }"),
        body: z.any().optional().describe("JSON body for POST endpoints. Provide for: onchain/query, onchain/sql. When set, the call is sent as POST; otherwise GET with params."),
        agent_id: z.string().optional().describe("Agent identifier for budget tracking and enforcement."),
      },
    },
    async ({ path, params, body, agent_id }) => {
      try {
        body = coerceBody(body);
        const cleanPath = path.replace(/^\/+/, "").replace(/^v1\/surf\//, "").replace(/^api\/v1\/surf\//, "");
        if (hasPathTraversal(cleanPath)) {
          return { content: [{ type: "text", text: formatError(`Invalid path '${path}'.`) }], isError: true };
        }
        const estimatedCost = estimateSurfCost(cleanPath);
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
          const confirm = await confirmSpend(server, { usd: estimatedCost, label: `surf · ${cleanPath}` });
          if (!confirm.ok) return { content: [{ type: "text", text: confirm.reason ?? "Charge cancelled." }] };
          const client = getClient() as unknown as SurfClient;
          const endpoint = `/v1/surf/${cleanPath}`;
          const result = body !== undefined
            ? await client.requestWithPaymentRaw(endpoint, body)
            : await client.getWithPaymentRaw(endpoint, params);
          recordSpending(budget, estimatedCost, agent_id);
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            structuredContent: asStructuredContent(result),
          };
        } finally {
          gate.release();
        }
      } catch (err) {
        return {
          content: [{ type: "text", text: formatError(extractErrorMessage(err)) }],
          isError: true,
        };
      }
    }
  );
}
