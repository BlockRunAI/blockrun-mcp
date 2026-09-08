// src/tools/price.ts
//
// Pyth-backed market data tool. Crypto, FX and commodity are fully free
// (price + history + list).
//
// Equity is catalog-only. Since 2026-09-05 the gateway answers every
// `stocks/{market}/price` and `/history` call (and the `usstock` alias) with a
// pre-payment 501 — "We do not currently serve equity prices" — after
// blockrun#517 moved the free tier onto licensed sources. `stocks/{market}/list`
// still serves the ticker catalog for free (the Solana gateway has no equity
// route at all — it answers with the site HTML).
//
// Paid stock price/history is therefore answered HERE, before the chain guard
// and before any network call: on the default Solana chain the Base-only guard
// used to fire first and tell the user to switch chains to pay for a route
// that 501s. The gateway's answer is a product decision with a contact
// address, not a transient fault, so pre-empting it loses nothing. Retire the
// pre-flight (and re-enable the paid path below it) once
// `curl https://blockrun.ai/v1/stocks/us/price/AAPL` answers 402 again.
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
import { reserveBudget, recordSpending } from "../utils/budget.js";
import { confirmSpend } from "../utils/confirm-spend.js";
import { withTxFee } from "../utils/tx-fee.js";
import type { BudgetState } from "../types.js";
import { baseOnlyMessage, getPriceClient } from "../utils/wallet.js";
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

/**
 * What the gateway itself answers for equity price/history since 2026-09-05
 * (HTTP 501, verified live 2026-09-08), said before the wallet is consulted.
 * Exported for the test; nothing here touches the network.
 */
export function equityNotServedMessage(action: string, category: string, market?: string): string {
  const mkt = market ?? "us";
  return `Error: Equity ${action === "history" ? "history" : "quotes"} are not served (gateway 501 for category "${category}").\n\n` +
    `The gateway withdrew equity price and history on 2026-09-05 — this is not an outage, retrying will not help, ` +
    `and nothing was charged (the wallet was not asked to sign).\n` +
    `The ticker catalog still works and is free: { action: "list", category: "stocks", market: "${mkt}" }.\n` +
    `For realtime or global equity coverage, contact hello@blockrun.ai.`;
}

export function registerPriceTool(server: McpServer, budget: BudgetState): void {
  server.registerTool(
    "blockrun_price",
    {
      description: `Realtime quotes and OHLC history for crypto, FX and commodities (Pyth-backed), plus the ticker catalog for 12 stock markets.

- action="price" — realtime quote for a symbol
- action="history" — OHLC bars between from/to (unix seconds)
- action="list" — discovery: list available symbols (free)

Pricing:
- crypto / fx / commodity: FREE across price, history and list
- stocks / usstock: list (ticker catalog) FREE; price/history NOT SERVED — gateway 501 before payment since 2026-09-05, nothing charged, do not retry

Stocks markets: us, hk, jp, kr, gb, de, fr, nl, ie, lu, cn, ca (required when category="stocks").

Examples:
- { action: "price", category: "crypto", symbol: "BTC-USD" }
- { action: "price", category: "fx", symbol: "EUR-USD" }
- { action: "history", category: "crypto", symbol: "ETH-USD", resolution: "D", from: 1700000000, to: 1710000000 }
- { action: "list", category: "crypto", query: "sol" }`,
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
      try {
        if (category === "stocks" && !market) {
          throw new Error("market is required when category='stocks'");
        }

        const paid = isPaidPriceCall(action, category);
        if (paid) {
          return {
            content: [{ type: "text", text: equityNotServedMessage(action, category, market) }],
            isError: true,
          };
        }
        const chainBlock = paid ? baseOnlyMessage("Paid stock price/history calls") : null;
        if (chainBlock) {
          return { content: [{ type: "text", text: formatError(chainBlock) }], isError: true };
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
        return {
          content: [{ type: "text", text: formatError(extractErrorMessage(err)) }],
          isError: true,
        };
      }
    }
  );
}
