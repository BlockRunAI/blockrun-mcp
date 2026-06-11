// src/tools/stall.ts
//
// The Stall (IntuiTek¹) — 209 pay-per-call AI data capabilities via x402.
// Path-based GET passthrough so the full cap catalog stays in the stall skill.
// Price range: $0.001–$0.065/call, settled in USDC on Base via x402.
//
// Settlement: each call settles directly to The Stall's Base treasury.
// BlockRun routes the request server-side to https://the-stall.intuitek.ai

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { checkBudget, recordSpending } from "../utils/budget.js";
import { getClient } from "../utils/wallet.js";
import { formatError, extractErrorMessage } from "../utils/errors.js";
import type { BudgetState } from "../types.js";

type StallClient = {
  getWithPaymentRaw: (endpoint: string, params?: Record<string, string>) => Promise<unknown>;
};

// Cost estimates for local budget pre-check.
// Actual settlement is upstream-authoritative (from the 402 response body).
const STALL_HIGH_CAPS = new Set([
  "company-due-diligence", "strategy-signal", "portfolio-risk-check",
  "defi-yield-scan", "regulatory-risk-scan", "patent-search", "sanctions-check",
]);

const STALL_MID_CAPS = new Set([
  "us-stock-price", "us-stock-history", "us-stock-news", "us-stock-financials",
  "eu-stock-price", "eu-stock-history", "jp-stock-price", "jp-stock-history",
  "kr-stock-price", "kr-stock-history", "au-stock-price", "au-stock-history",
  "market-gex", "options-chain", "options-flow", "insider-trades",
  "congressional-trades", "sec-edgar-search", "sec-edgar-filing",
  "twitter-intel", "reddit-intel", "polymarket-intel",
]);

function estimateStallCost(cap: string): number {
  const c = cap.toLowerCase();
  if (STALL_HIGH_CAPS.has(c)) return 0.065;
  if (STALL_MID_CAPS.has(c)) return 0.015;
  if (
    c.startsWith("us-stock") || c.startsWith("eu-stock") || c.startsWith("jp-stock") ||
    c.startsWith("kr-stock") || c.startsWith("au-stock") || c.startsWith("options-") ||
    c.startsWith("insider-") || c.startsWith("sec-edgar")
  ) return 0.015;
  return 0.003;
}

export function registerStallTool(server: McpServer, budget: BudgetState): void {
  server.registerTool(
    "blockrun_stall",
    {
      description: `209 pay-per-call AI data capabilities via The Stall (IntuiTek¹). No API keys. USDC on Base.

Coverage (full catalog and worked examples in the stall skill):
- Equities: US/EU/JP/KR/AU stock prices, OHLCV, earnings, dividends, financials, analyst estimates
- Options microstructure: dealer GEX (gamma exposure), gamma flip level, vol regime via CBOE data
- Crypto & DeFi: token prices, DEX liquidity, Polymarket intelligence, DeFiLlama TVL, yield pools
- Macro: Treasury yields, FRED economic series, G10 FX rates, World Bank GDP/inflation
- Regulatory: congressional trades, insider filings, SEC/EDGAR search, sanctions screening
- News & signals: GDELT 24h global synthesis, Reddit social momentum, Hacker News intelligence
- Climate & weather: 85-year ERA5 historical climate, live weather, air quality index
- Social: Twitter/X user lookup and tweet search (x402-to-x402 via twit.sh)
- Specialized: patent search, Wayback Machine archive access, meme token radar (Solana)

Pricing: $0.001–$0.065/call. Full 209-cap list: https://the-stall.intuitek.ai/health

Selected caps (full catalog in the stall skill):
  us-stock-price      ticker=AAPL                        ($0.018)
  market-gex          ticker=SPY days_out=21             ($0.020)
  polymarket-intel    query=bitcoin                      ($0.008)
  global-news-intel   topic=federal+reserve              ($0.003)
  treasury-rates      maturity=10Y                       ($0.001)
  climate-history     lat=40.7 lon=-74.0 years=30        ($0.005)
  sec-edgar-search    q=apple+buyback                    ($0.007)
  insider-trades      ticker=NVDA                        ($0.008)
  twitter-intel       action=lookup_user handle=sama     ($0.015)
  defi-tvl            protocol=uniswap                   ($0.003)`,
      inputSchema: {
        cap: z.string().describe("Capability name, e.g. 'us-stock-price', 'market-gex', 'polymarket-intel'. Full list: https://the-stall.intuitek.ai/health"),
        params: z.record(z.string(), z.string()).optional().describe("Query parameters for the cap, e.g. { ticker: 'AAPL' } or { query: 'bitcoin', limit: '5' }"),
        agent_id: z.string().optional().describe("Agent identifier for budget tracking and enforcement."),
      },
    },
    async ({ cap, params, agent_id }) => {
      try {
        const cleanCap = cap.replace(/^\/+/, "").replace(/\.js$/, "").toLowerCase();
        const estimatedCost = estimateStallCost(cleanCap);
        const budgetCheck = checkBudget(budget, agent_id, estimatedCost);
        if (!budgetCheck.allowed) {
          return {
            content: [{ type: "text", text: `${budgetCheck.reason}. Use blockrun_wallet action:"report" to see usage or action:"delegate" to increase agent budget.` }],
            isError: true,
          };
        }

        const client = getClient() as unknown as StallClient;
        const result = await client.getWithPaymentRaw(`/v1/stall/${cleanCap}`, params);
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
