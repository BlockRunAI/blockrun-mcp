// src/tools/polymarket.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asStructuredContent } from "../utils/body.js";
import { extractErrorMessage } from "../utils/errors.js";
import { executeTrade, listOpenOrders, cancelOrdersAction, getSessionLedger, type ToolResult } from "../utils/polymarket/orders.js";
import { listPositions } from "../utils/polymarket/positions.js";
import { redeemPosition } from "../utils/polymarket/redeem.js";
import { runSetup } from "../utils/polymarket/setup.js";

/**
 * Trading is intentionally NOT gated on the x402 budget ledger: that ledger
 * meters BlockRun API spend from the Base payment wallet, while bets are the
 * user's own pUSD on Polygon — mixing them would corrupt both. The guardrails
 * here are confirm:true (hard-required to sign anything), the per-order
 * POLYMARKET_MAX_BET_USD cap, and the optional session cap (see orders.ts).
 */
export function registerPolymarketTool(server: McpServer): void {
  server.registerTool(
    "blockrun_polymarket",
    {
      description: `Trade on Polymarket prediction markets (CLOB V2, Polygon). REAL MONEY — orders spend pUSD held in your Polymarket deposit wallet, signed locally by your BlockRun key. Free tool (no BlockRun API charge); discover markets/prices/token IDs with blockrun_markets first.

Run action:"setup" FIRST (and again after funding). It creates a gasless deposit wallet owned by your key, checks pUSD balance + exchange approvals, and prints funding instructions. Needs Polymarket relayer API creds via env (POLYMARKET_RELAYER_API_KEY/_SECRET/_PASSPHRASE — setup explains how to get them).

Actions:
- setup — create/inspect deposit wallet, funding, approvals (confirm:true to sign the approval batch), region check. Idempotent.
- buy / sell — token_id (or condition_id+outcome) + either price+size (limit) or amount_usd (market buy) / size (market sell). confirm:true REQUIRED to place; omitting it returns a dry-run preview. Per-order cap: POLYMARKET_MAX_BET_USD (default $25).
- orders — list open orders (optional condition_id filter)
- cancel — order_id:"…" or all:true
- positions — holdings incl. redeemable winnings (free Data-API)
- redeem — claim resolved winnings for condition_id (confirm:true; gasless)

Prices are probabilities 0–1 on the market's tick grid. token_id = clobTokenIds from blockrun_markets Polymarket data. Order placement is geoblocked in some regions (US/UK/EU are close-only; cancel/sell/redeem still work) — setup reports your status.`,
      inputSchema: {
        action: z.enum(["setup", "buy", "sell", "cancel", "orders", "positions", "redeem"])
          .describe("Operation to perform"),
        token_id: z.string().optional()
          .describe("Outcome token ID (decimal ERC-1155 id from blockrun_markets clobTokenIds)"),
        condition_id: z.string().optional()
          .describe("Market condition ID (0x…). With `outcome` it resolves token_id; required for redeem."),
        outcome: z.string().optional()
          .describe("Outcome label (e.g. 'Yes') — used with condition_id when token_id is omitted"),
        price: z.number().gt(0).lt(1).optional()
          .describe("Limit price as probability (0–1). Omit for a market order."),
        size: z.number().positive().optional()
          .describe("Shares — required for limit orders and market sells"),
        amount_usd: z.number().positive().optional()
          .describe("pUSD dollars to spend — required for market buys"),
        order_type: z.enum(["GTC", "GTD", "FOK", "FAK"]).optional()
          .describe("Default: GTC for limit orders, FOK for market orders"),
        expires_at: z.number().int().positive().optional()
          .describe("Unix seconds expiry (GTD only, ≥ ~3 min in the future)"),
        post_only: z.boolean().optional()
          .describe("Maker-only limit order (rejected if it would cross the book)"),
        order_id: z.string().optional().describe("Order ID to cancel"),
        all: z.boolean().optional().describe("cancel: cancel ALL open orders"),
        confirm: z.boolean().optional()
          .describe("Must be true to place orders / sign approvals / redeem. Omit for a dry-run preview."),
        agent_id: z.string().optional()
          .describe("Tag for the session betting ledger (bets do NOT draw from the x402 API budget)"),
      },
    },
    async (args) => {
      try {
        let result: ToolResult;
        switch (args.action) {
          case "setup":
            result = await runSetup({ confirm: args.confirm === true });
            break;
          case "buy":
          case "sell":
            result = await executeTrade({ ...args, action: args.action });
            break;
          case "orders":
            result = await listOpenOrders({ condition_id: args.condition_id });
            break;
          case "cancel":
            result = await cancelOrdersAction({ order_id: args.order_id, all: args.all });
            break;
          case "positions":
            result = await listPositions();
            break;
          case "redeem":
            result = await redeemPosition({ condition_id: args.condition_id, confirm: args.confirm });
            break;
        }
        if (result.isError) {
          // Polymarket error texts are already actionable (setup/proxy/region
          // guidance) — do NOT route them through formatError, whose generic
          // "balance" hint points at the BASE payment wallet, not pUSD.
          return { content: [{ type: "text" as const, text: `Error: ${result.text}` }], isError: true };
        }
        return {
          content: [{ type: "text" as const, text: result.text }],
          structuredContent: asStructuredContent(result.structured ?? { session: getSessionLedger() }),
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error: ${extractErrorMessage(err)}` }],
          isError: true,
        };
      }
    },
  );
}
