// src/tools/markets.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { reserveBudget, recordSpending } from "../utils/budget.js";
import { asStructuredContent, coerceBody } from "../utils/body.js";
import { getClient } from "../utils/wallet.js";
import { extractErrorMessage, formatError } from "../utils/errors.js";
import { hasPathTraversal } from "../utils/path-safety.js";
import type { BudgetState } from "../types.js";

function estimateMarketCost(path: string, body: unknown): number {
  if (body !== undefined) return 0.005;
  const p = path.toLowerCase();
  if (
    p.includes("wallet") ||
    p.includes("smart") ||
    p.includes("matching-markets") ||
    p.includes("markets/search") ||
    p.includes("binance/")
  ) {
    return 0.005;
  }
  return 0.001;
}

export function registerMarketsTool(server: McpServer, budget: BudgetState): void {
  server.registerTool(
    "blockrun_markets",
    {
      description: `Prediction market + derivatives data via Predexon aggregator. Flat $0.0075/call (every endpoint)/call.

CANONICAL CROSS-VENUE (Tier 1) — Predexon v2 unified data layer:
- markets — list canonical market/question containers with cross-venue Predexon IDs
- markets/listings — venue-native executable listings flattened across canonical markets
- outcomes/:predexon_id — resolve a canonical outcome ID to its market context + venue listings
  Filter with ?venue=polymarket|kalshi|limitless|opinion|predictfun, ?status=, ?category=, ?league=, ?event_id=, ?pagination_key=

POLYMARKET (Tier 1):
- polymarket/events, polymarket/markets — list events/markets (filter, sort, paginate)
- polymarket/markets/keyset, polymarket/events/keyset — same data, cursor-based keyset pagination (use ?pagination_key=)
- polymarket/crypto-updown — crypto up/down markets
- polymarket/market-price/:token_id — current/historical price
- polymarket/candlesticks/:condition_id — OHLCV by market
- polymarket/candlesticks/token/:token_id — OHLCV by single outcome token
- polymarket/volume-chart/:condition_id — volume w/ YES/NO split
- polymarket/orderbooks, polymarket/trades, polymarket/activity
- polymarket/markets/:token_id/volume, polymarket/markets/:condition_id/open_interest
- polymarket/positions — user positions
- polymarket/leaderboard, polymarket/leaderboard/market/:condition_id
- polymarket/cohorts/stats, polymarket/market/:condition_id/top-holders
- polymarket/uma/markets, polymarket/uma/market/:condition_id — UMA oracle questions/timeline

POLYMARKET (Tier 2 — wallet/smart-money analytics):
- polymarket/wallet/:wallet — full smart-wallet profile
- polymarket/wallet/:wallet/markets, .../similar
- polymarket/wallet/pnl/:wallet, .../positions/:wallet, .../volume-chart/:wallet
- polymarket/wallets/profiles, polymarket/wallets/filter — batch + AND/OR filter
- polymarket/market/:condition_id/smart-money, polymarket/markets/smart-activity

WALLET IDENTITY & CLUSTERING (Tier 2) — cross-context labels + on-chain relationship graph:
- polymarket/wallet/identity/:wallet — fetch identity + profile metadata for one wallet
- polymarket/wallet/identities — POST { addresses: [...] } for bulk lookup (up to 200 wallets)
- polymarket/wallet/:address/cluster — discover wallets connected via on-chain transfers + identity proofs

SPORTS (Tier 1):
- sports/categories — list available sports categories
- sports/markets — list sports markets grouped by game (filter ?league=, ?sport_type=, ?status=, ?venue=)
- sports/markets/:game_id — single sports game with all venue outcomes
- sports/outcomes/:predexon_id — equivalent sports outcomes across venues for a Predexon ID

KALSHI (Tier 1): kalshi/markets, kalshi/trades, kalshi/orderbooks
LIMITLESS / OPINION / PREDICT.FUN (Tier 1): {platform}/markets, {platform}/orderbooks
DFLOW: dflow/trades (T1), dflow/wallet/positions/:wallet (T2), dflow/wallet/pnl/:wallet (T2)
BINANCE FUTURES (Tier 2): binance/candles/:symbol, binance/ticks/:symbol

CROSS-PLATFORM:
- matching-markets, matching-markets/pairs — equivalent markets across Polymarket+Kalshi (T2)
- markets/search — search across all platforms in one call (T2)

Pass query params via 'params' (GET). Use 'body' only for POST endpoints (e.g. polymarket/wallet/identities).`,
      inputSchema: {
        path: z.string().describe("Endpoint path, e.g. 'polymarket/events', 'kalshi/markets/KXBTC-25MAR14', 'polymarket/wallet/0xabc...', 'markets/search'"),
        params: z.record(z.string(), z.string()).optional().describe("Query parameters for GET requests (e.g. { limit: '20', active: 'true' })"),
        body: z.any().optional().describe("JSON body for POST queries (triggers pmQuery — most endpoints are GET)"),
        agent_id: z.string().optional().describe("Agent identifier for budget tracking and enforcement."),
      },
    },
    async ({ path, params, body, agent_id }) => {
      try {
        body = coerceBody(body);
        // `path` is forwarded verbatim into /v1/pm/${path}; a `..` segment would
        // normalize past the namespace, so reject traversal before billing.
        if (hasPathTraversal(path)) {
          return { content: [{ type: "text", text: formatError(`Invalid path '${path}'.`) }], isError: true };
        }
        const estimatedCost = estimateMarketCost(path, body);
        const gate = reserveBudget(budget, agent_id, estimatedCost);
        if (!gate.allowed) {
          return {
            content: [{ type: "text", text: `${gate.reason}. Use blockrun_wallet action:"report" to see usage or action:"delegate" to increase agent budget.` }],
            isError: true,
          };
        }
        try {
          const llm = getClient();
          const result = body !== undefined
            ? await llm.pmQuery(path, body)
            : await llm.pm(path, params);
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
