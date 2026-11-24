// src/tools/price.ts
//
// Pyth-backed market data tool. Crypto, FX and commodity are fully free
// (price + history + list).
//
// Equity: since 2026-11-23 the US PRICE is served again, from on-chain DEX
// pools of tokenized stocks (blockrun spec OCS, blockrun#1163, blockrun-sol#676).
// Each gateway reports its OWN chain: blockrun.ai prices Coinbase Tokenized
// Stocks on Base, sol.blockrun.ai prices xStocks on Solana. So the active chain
// decides which market you read — there is no chain guard. $0.005 per call; a
// ticker with no on-chain market on that chain is a 404 before payment.
// US history and every non-US price/history still answer 501 before payment,
// and that answer is given HERE, before any network call.
//
// Supported markets: us, hk, jp, kr, gb, de, fr, nl, ie, lu, cn, ca.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type {
  PriceCategory,
  StockMarket,
  BarResolution,
  MarketSession,
} from "@blockrun/llm";
import { reserveBudget, recordSpending, recordActualSpend } from "../utils/budget.js";
import { buildClient } from "../utils/wallet.js";
import { ledgerFallback, rawGet, type RawClient } from "../utils/raw-call.js";
import { pathToolFailure } from "../utils/path-tool-catch.js";
import { confirmSpend } from "../utils/confirm-spend.js";
import { withTxFee } from "../utils/tx-fee.js";
import type { BudgetState } from "../types.js";
import { getPriceClient } from "../utils/wallet.js";
import { extractErrorMessage, formatError } from "../utils/errors.js";
import { TOOL_ANNOTATIONS } from "../tool-annotations.js";

const CATEGORY = z.enum(["crypto", "fx", "commodity", "usstock", "stocks"]);
const MARKET = z.enum([
  "us", "hk", "jp", "kr", "gb", "de",
  "fr", "nl", "ie", "lu", "cn", "ca",
]);
const RESOLUTION = z.enum(["1", "5", "15", "60", "240", "D", "W", "M"]);
const SESSION = z.enum(["pre", "post", "on"]);
const ACTION = z.enum(["price", "history", "list"]);

function isPaidPriceCall(action: "price" | "history" | "list", category: string): boolean {
  return action !== "list" && (category === "stocks" || category === "usstock");
}

/** The one equity call the gateways serve: a US price, on-chain (OCS). */
export function isOnchainStockPrice(action: string, category: string, market?: string): boolean {
  // usstock is the US alias, but a caller who also names another market asked for that market (GLM review).
  return action === "price" && (category === "usstock" || category === "stocks") && (market ?? "us") === "us";
}

/**
 * Base price of an on-chain stock price; the gateway adds its tx fee. withTxFee
 * reserves base + $0.002 = $0.006 for a call that settles at $0.005 (the safe
 * direction, see utils/tx-fee.ts); recordActualSpend books what actually settled.
 */
export const ONCHAIN_STOCK_BASE_USD = 0.004;

/**
 * What the gateway itself answers for equity price/history since 2026-09-05
 * (HTTP 501, verified live 2026-09-08), said before the wallet is consulted.
 * Exported for the test; nothing here touches the network.
 */
export function equityNotServedMessage(action: string, category: string, market?: string): string {
  const mkt = market ?? "us";
  const what = action === "history" ? "Equity history is" : `Equity quotes for market "${mkt}" are`;
  return `Error: ${what} not served (gateway 501 for category "${category}").\n\n` +
    `This is not an outage, retrying will not help, and nothing was charged (the wallet was not asked to sign).\n` +
    `What is served: the on-chain US stock PRICE — { action: "price", category: "stocks", market: "us", symbol: "NVDA" } ($0.005, from tokenized-stock DEX pools on your active chain).\n` +
    `The ticker catalog is free: { action: "list", category: "stocks", market: "${mkt}" }.\n` +
    `For other equity coverage, contact hello@blockrun.ai.`;
}

export function registerPriceTool(server: McpServer, budget: BudgetState): void {
  server.registerTool(
    "blockrun_price",
    {
      description: `Prices for crypto, FX and commodities (free daily closes and OHLC history), on-chain US stock prices, and the ticker catalog for 12 stock markets.

- action="price" — realtime quote for a symbol
- action="history" — OHLC bars between from/to (unix seconds)
- action="list" — discovery: list available symbols (free)

Pricing:
- crypto / fx / commodity: FREE across price, history and list
- stocks / usstock, market "us", action "price": $0.005 — ON-CHAIN price from tokenized-stock DEX pools on your ACTIVE chain (Base: Coinbase Tokenized Stocks; Solana: xStocks). Returns the price, every pool with its liquidity, the dividend multiplier, the US session and SEC company facts. It is the token's price on that chain, not an exchange quote. A ticker with no on-chain market on your chain is refused before payment; the other chain may have it (see otherChains).
- stocks / usstock: list (ticker catalog) FREE; US history and every non-US price/history NOT SERVED — 501 before payment, nothing charged, do not retry

Stocks markets: us, hk, jp, kr, gb, de, fr, nl, ie, lu, cn, ca (required when category="stocks").

Examples:
- { action: "price", category: "crypto", symbol: "BTC-USD" }
- { action: "price", category: "fx", symbol: "EUR-USD" }
- { action: "history", category: "crypto", symbol: "ETH-USD", resolution: "D", from: 1700000000, to: 1710000000 }
- { action: "list", category: "crypto", query: "sol" }
- { action: "price", category: "stocks", market: "us", symbol: "NVDA" }   ($0.005, on-chain)`,
      annotations: TOOL_ANNOTATIONS.readOnlyOpenWorld,
      inputSchema: {
        action: ACTION.describe("Which endpoint to hit: price, history, or list."),
        category: CATEGORY.describe("Market category."),
        symbol: z.string().optional().describe("Ticker (required for price+history). e.g. BTC-USD, EUR-USD, XAU-USD."),
        market: MARKET.optional().describe("Stock market code — required when category='stocks'."),
        session: SESSION.optional().describe("Equity session hint (pre/post/on); ignored for non-equity."),
        resolution: RESOLUTION.optional().describe("Bar resolution for history (default D)."),
        from: z.number().optional().describe("History window start (unix seconds)."),
        to: z.number().optional().describe("History window end (unix seconds)."),
        query: z.string().optional().describe("Free-text filter for list."),
        limit: z.number().int().positive().max(2000).optional().describe("Max items for list (default 100, max 2000)."),
        agent_id: z.string().optional().describe("Agent identifier for budget tracking and enforcement."),
      },
    },
    async ({ action, category, symbol, market, session, resolution, from, to, query, limit, agent_id }) => {
      // The reserve of the paid request in flight, for the catch: 0 until the
      // line before rawGet, so nothing thrown earlier can book a charge.
      let sentUsd = 0;
      try {
        // On-chain US stock price (OCS): the active chain's gateway answers for its own chain.
        if (isOnchainStockPrice(action, category, market)) {
          if (!symbol) throw new Error("symbol is required for action='price'");
          const estimatedCost = withTxFee(ONCHAIN_STOCK_BASE_USD);
          const gate = reserveBudget(budget, agent_id, estimatedCost);
          if (!gate.allowed) {
            return {
              content: [{ type: "text", text: `${gate.reason}. Use blockrun_wallet action:"report" to see usage or action:"delegate" to increase agent budget.` }],
              isError: true,
            };
          }
          try {
            const confirm = await confirmSpend(server, { usd: estimatedCost, label: `price · on-chain ${symbol}` });
            if (!confirm.ok) return { content: [{ type: "text", text: confirm.reason ?? "Charge cancelled." }] };
            // A fresh client per call, for the same reason blockrun_defi builds one (spend-window attribution).
            const client = buildClient() as unknown as RawClient;
            sentUsd = estimatedCost;
            const { data: result, paidUsd } = await rawGet(client, `/v1/stocks/us/price/${encodeURIComponent(symbol)}`);
            recordActualSpend(budget, paidUsd, ledgerFallback(estimatedCost), agent_id);
            return {
              content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
              structuredContent: (typeof result === "object" && result !== null && !Array.isArray(result)
                ? result
                : { result }) as Record<string, unknown>,
            };
          } finally {
            gate.release();
          }
        }
        // Equity price/history first — before the market-required throw, so the
        // most natural stocks call (no market) gets the real answer in one round
        // trip instead of a validation error for a route that is not served.
        const paid = isPaidPriceCall(action, category);
        if (paid) {
          return {
            content: [{ type: "text", text: equityNotServedMessage(action, category, market) }],
            isError: true,
          };
        }
        // Re-enable when the equity route returns (see the header): the paid
        // path is Base-only, so restore `baseOnlyMessage("Paid stock price/history calls")`
        // here ahead of the reservation.
        if (category === "stocks" && !market) {
          throw new Error("market is required when category='stocks'");
        }

        // withTxFee: the gateway charges base + $0.002 (src/utils/tx-fee.ts), so a
        // paid stock call settles at $0.0030 against a $0.001 base — reserving the
        // base was 3x short. Free categories (crypto/fx/commodity) stay $0.
        const estimatedCost = paid ? withTxFee(0.001) : 0;
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
          const confirm = await confirmSpend(server, { usd: estimatedCost, label: `price · ${category} ${symbol ?? query ?? ""}`.trim() });
          if (!confirm.ok) return { content: [{ type: "text", text: confirm.reason ?? "Charge cancelled." }] };
          const priceClient = getPriceClient(paid);

          if (action === "price") {
            if (!symbol) throw new Error("symbol is required for action='price'");
            const task = () => priceClient.price(category as PriceCategory, symbol, {
              market: market as StockMarket | undefined,
              session: session as MarketSession | undefined,
            });
            const result = await task();
            if (estimatedCost > 0) recordSpending(budget, estimatedCost, agent_id);
            return {
              content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
              structuredContent: result as unknown as Record<string, unknown>,
            };
          }

          if (action === "history") {
            if (!symbol) throw new Error("symbol is required for action='history'");
            if (from === undefined) throw new Error("from (unix seconds) is required for action='history'");
            const task = () => priceClient.history(category as PriceCategory, symbol, {
              market: market as StockMarket | undefined,
              session: session as MarketSession | undefined,
              resolution: (resolution ?? "D") as BarResolution,
              from,
              to,
            });
            const result = await task();
            if (estimatedCost > 0) recordSpending(budget, estimatedCost, agent_id);
            return {
              content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
              structuredContent: result as unknown as Record<string, unknown>,
            };
          }

          // action === "list"
          const result = await priceClient.listSymbols(category as PriceCategory, {
            market: market as StockMarket | undefined,
            query,
            limit,
          });
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            structuredContent: result as unknown as Record<string, unknown>,
          };
        } finally {
          gate.release();
        }
      } catch (err) {
        // A paid on-chain stock call books the reserve only if the payment went out (utils/path-tool-catch.ts).
        if (sentUsd > 0) return pathToolFailure(err, { budget, agentId: agent_id, sentUsd });
        return {
          content: [{ type: "text", text: formatError(extractErrorMessage(err)) }],
          isError: true,
        };
      }
    }
  );
}
