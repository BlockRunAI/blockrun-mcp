// src/tools/price.ts
//
// Pyth-backed market data tool. Crypto, FX and commodity are fully free
// (price + history + list); stocks (`stocks/{market}` and the `usstock`
// legacy alias) charge $0.001 per price or history call.
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
import { checkBudget, recordSpending } from "../utils/budget.js";
import type { BudgetState } from "../types.js";
import { getChain, getPriceClient } from "../utils/wallet.js";
import { formatError } from "../utils/errors.js";

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

export function registerPriceTool(server: McpServer, budget: BudgetState): void {
  server.registerTool(
    "blockrun_price",
    {
      description: `Realtime quotes and OHLC history for crypto, FX, commodities and 12 global stock markets (Pyth-backed).

- action="price" — realtime quote for a symbol
- action="history" — OHLC bars between from/to (unix seconds)
- action="list" — discovery: list available symbols (free)

Pricing:
- crypto / fx / commodity: FREE across price, history and list
- stocks / usstock: $0.001 per price or history call (list free)

Stocks markets: us, hk, jp, kr, gb, de, fr, nl, ie, lu, cn, ca (required when category="stocks").

Examples:
- { action: "price", category: "crypto", symbol: "BTC-USD" }
- { action: "price", category: "stocks", symbol: "AAPL", market: "us" }
- { action: "history", category: "crypto", symbol: "ETH-USD", resolution: "D", from: 1700000000, to: 1710000000 }
- { action: "list", category: "crypto", query: "sol" }`,
      inputSchema: {
        action: ACTION.describe("Which endpoint to hit: price, history, or list."),
        category: CATEGORY.describe("Market category."),
        symbol: z.string().optional().describe("Ticker (required for price+history). e.g. BTC-USD, AAPL, EUR-USD."),
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
        if (paid && getChain() !== "base") {
          return {
            content: [{ type: "text", text: formatError("Paid stock price/history calls currently settle on Base only. Switch BlockRun to Base (for example: run blockrun_wallet with action:chain chain:base) and fund the Base wallet with USDC.") }],
            isError: true,
          };
        }

        const estimatedCost = paid ? 0.001 : 0;
        const budgetCheck = checkBudget(budget, agent_id, estimatedCost);
        if (!budgetCheck.allowed) {
          return {
            content: [{ type: "text", text: `${budgetCheck.reason}. Use blockrun_wallet action:"report" to see usage or action:"delegate" to increase agent budget.` }],
            isError: true,
          };
        }

        const priceClient = getPriceClient(paid);

        if (action === "price") {
          if (!symbol) throw new Error("symbol is required for action='price'");
          const result = await priceClient.price(category as PriceCategory, symbol, {
            market: market as StockMarket | undefined,
            session: session as MarketSession | undefined,
          });
          if (estimatedCost > 0) recordSpending(budget, estimatedCost, agent_id);
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            structuredContent: result as unknown as Record<string, unknown>,
          };
        }

        if (action === "history") {
          if (!symbol) throw new Error("symbol is required for action='history'");
          if (from === undefined) throw new Error("from (unix seconds) is required for action='history'");
          const result = await priceClient.history(category as PriceCategory, symbol, {
            market: market as StockMarket | undefined,
            session: session as MarketSession | undefined,
            resolution: (resolution ?? "D") as BarResolution,
            from,
            to,
          });
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
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: formatError(msg) }],
          isError: true,
        };
      }
    }
  );
}
