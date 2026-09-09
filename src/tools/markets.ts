// src/tools/markets.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { reserveBudget, recordActualSpend } from "../utils/budget.js";
import { confirmSpend } from "../utils/confirm-spend.js";
import { asStructuredContent, coerceBody } from "../utils/body.js";
import { getClient } from "../utils/wallet.js";
import { ledgerFallback, rawGet, rawPost, type RawClient } from "../utils/raw-call.js";
import { extractErrorMessage, formatError } from "../utils/errors.js";
import { hasPathTraversal } from "../utils/path-safety.js";
import type { BudgetState } from "../types.js";
import { TOOL_ANNOTATIONS } from "../tool-annotations.js";
import { describeDegradedSportsFailure, isDegradedSportsPath, validateMarketRequest } from "../utils/markets-validation.js";

// What x402 CHARGES, which is not the 402's JSON `price` field. That field is the
// BASE ($0.0075); the charge is base + a $0.002 flat transaction fee, and it lives
// in `maxAmountRequired` inside the base64 `payment-required` header. Decoded live
// 2026-07-15: every /v1/pm/* route quotes maxAmountRequired=9500 → $0.0095, flat.
// The gateway states the same split in src/app/api/v1/pm/[...path]/route.ts:
//   "Tier 1 (GET) = $0.0095/call ($0.0075 base + $0.002 tx fee)"
//
// This used to return the old tiers (0.001/0.005). Predexon went flat on
// 2026-07-15 and the tool description was updated but this was not — so the gate
// reserved $0.001 against a $0.0095 charge (~9.5x short) and recordSpending()
// booked $0.001 of a $0.0095 spend, under-counting the ledger too.
export const MARKETS_PRICE_USD = 0.0095;

function estimateMarketCost(_path: string, _body: unknown): number {
  return MARKETS_PRICE_USD;
}

export function registerMarketsTool(server: McpServer, budget: BudgetState): void {
  server.registerTool(
    "blockrun_markets",
    {
      description: `Prediction market + derivatives data via Predexon aggregator. Flat $0.0075 base per call (every endpoint) plus the gateway's network fee — $0.001 on Base today, none quoted on Solana; the 402 header carries the exact charge (we reserve $0.0095).

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

SPORTS — sports/* (categories, markets, markets/:game_id, outcomes/:predexon_id) DEGRADED, do not call: Predexon 500 on every call since 2026-08-04; the gateway releases the payment on that upstream 500. Use markets/search { q: "NBA" } or polymarket/events { search: "NBA" } instead — no live route takes a "league" param.

KALSHI: kalshi/markets, kalshi/trades, kalshi/orderbooks
LIMITLESS / OPINION / PREDICT.FUN: {platform}/markets, {platform}/orderbooks
BINANCE FUTURES: binance/candles/:symbol, binance/ticks/:symbol

CROSS-PLATFORM:
- markets/search — search every venue in one call (search term is "q"). The only canonical-layer route left: markets, markets/listings, outcomes/:id and matching-markets(/pairs) were removed upstream 2026-08-04 and 404 before payment.

REQUEST CONTRACTS:
- Discover current markets with markets/search (its search term is "q"), then resolve the chosen Polymarket market with polymarket/markets/keyset and condition_id.
- On polymarket/markets{,/keyset} the free-text filter is "search" (NOT "q"), and status:"open"/"closed" replaces Gamma's active/closed. "sort", "end_after", and "end_before" are supported; "order"/"ascending" are not.
- Candlesticks interval is integer minutes ("1440", not "1h"); it is OPTIONAL (the server defaults). Which intervals a market serves varies — 1440 may work where 60 does not. start_time/end_time are Unix seconds.
- polymarket/orderbooks requires token_id plus start_time/end_time in Unix milliseconds.
- Smart-money needs a smart-wallet CRITERION (min_trades, min_volume, min_roi, min_*_pnl, min_win_rate, min_profit_factor). "window" only scopes time and is NOT sufficient on its own. Default: { window: "30d", min_trades: "100" }.

Pass query params via 'params' (GET). Use 'body' only for POST endpoints (e.g. polymarket/wallet/identities).`,
      annotations: TOOL_ANNOTATIONS.readOnlyOpenWorld,
      inputSchema: {
        path: z.string().describe("Endpoint path, e.g. 'polymarket/events', 'kalshi/markets/KXBTC-25MAR14', 'polymarket/wallet/0xabc...', 'markets/search'"),
        params: z.record(z.string(), z.string()).optional().describe("Query parameters for GET requests (e.g. markets/search uses { q: 'Bitcoin', status: 'open', venue: 'polymarket', limit: '20' })"),
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
        const validationError = validateMarketRequest(path, params, body);
        if (validationError) {
          return { content: [{ type: "text", text: formatError(validationError) }], isError: true };
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
          // Human-in-the-loop (BLOCKRUN_CONFIRM_SPEND=on): ask before signing. A
          // decline returns here — nothing is sent, and the finally releases the
          // reservation. No-ops when off, sub-threshold, or unsupported by the client.
          // sports/* is reserved and confirmed like any other route: if Predexon
          // recovers, the call WILL settle $0.0095, and an un-reserved settle is the
          // worse failure. The label says why the prompt will probably be moot.
          const confirm = await confirmSpend(server, {
            usd: estimatedCost,
            label: isDegradedSportsPath(path) ? `markets · ${path} (degraded upstream — likely fails, usually uncharged)` : `markets · ${path}`,
          });
          if (!confirm.ok) return { content: [{ type: "text", text: confirm.reason ?? "Charge cancelled." }] };
          // rawGet/rawPost rather than the SDK's pm()/pmQuery(): those are one-line
          // wrappers over exactly `/v1/pm/${path}` on the same raw methods
          // (client.ts:1534, 1552), so the wallet rail is byte-identical — but the
          // account rail then goes through utils/api-key-call.ts, which reads the
          // settled `x-blockrun-cost-usd` instead of discarding the response.
          const llm = getClient() as unknown as RawClient;
          const endpoint = `/v1/pm/${path}`;
          const { data: result, paidUsd } = body !== undefined
            ? await rawPost(llm, endpoint, body)
            : await rawGet(llm, endpoint, params);
          recordActualSpend(budget, paidUsd, ledgerFallback(estimatedCost), agent_id);

          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            structuredContent: asStructuredContent(result),
          };
        } finally {
          gate.release();
        }
      } catch (err) {
        const message = extractErrorMessage(err);
        // A sports/* 5xx is the known Predexon outage, not a blip, and the
        // gateway released the payment — say so instead of "after payment …
        // try again in a few minutes" (blockrun-mcp#132).
        const degraded = describeDegradedSportsFailure(path, message);
        return {
          content: [{ type: "text", text: degraded ?? formatError(message) }],
          isError: true,
        };
      }
    }
  );
}
