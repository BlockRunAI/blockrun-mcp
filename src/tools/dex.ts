// src/tools/dex.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fetchWithTimeout } from "../utils/http.js";

export function registerDexTool(server: McpServer): void {
  server.registerTool(
    "blockrun_dex",
    {
      description: `Get real-time DEX data from DexScreener. FREE - no payment required.

Use for:
- Token prices and liquidity across chains
- Trading volume and price changes
- Finding token pairs and contracts

Examples:
  blockrun_dex({ query: "SOL" })           -> Search for SOL pairs
  blockrun_dex({ token: "So11...xxx" })    -> Get specific token data
  blockrun_dex({ symbol: "PEPE" })         -> Search by symbol`,
      inputSchema: {
        query: z.string().optional().describe("Search query (token name, symbol, or address)"),
        token: z.string().optional().describe("Token address for direct lookup"),
        symbol: z.string().optional().describe("Token symbol to search"),
        chain: z.string().optional().describe("Filter by chain (ethereum, solana, base, etc.)"),
      },
    },
    async ({ query, token, symbol, chain }) => {
      try {
        let url: string;
        let searchTerm = query || symbol || "";

        if (token) {
          url = `https://api.dexscreener.com/latest/dex/tokens/${token}`;
        } else if (searchTerm) {
          url = `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(searchTerm)}`;
        } else {
          return {
            content: [{ type: "text", text: "Provide query, token address, or symbol" }],
            isError: true,
          };
        }

        const response = await fetchWithTimeout(url, {}, 8000);
        if (!response.ok) {
          throw new Error(`DexScreener API error: ${response.status}`);
        }

        const data = await response.json() as {
          pairs?: Array<{
            chainId: string;
            dexId: string;
            pairAddress: string;
            baseToken: { address: string; name: string; symbol: string };
            quoteToken: { symbol: string };
            priceUsd: string;
            priceNative: string;
            volume: { h24: number };
            priceChange: { h24: number };
            liquidity: { usd: number };
            fdv: number;
            txns: { h24: { buys: number; sells: number } };
          }>;
        };

        let pairs = data.pairs || [];

        // Filter by chain if specified
        if (chain && pairs.length > 0) {
          const chainLower = chain.toLowerCase();
          pairs = pairs.filter(p => p.chainId.toLowerCase().includes(chainLower));
        }

        // Take top 10 pairs by volume
        pairs = pairs
          .sort((a, b) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0))
          .slice(0, 10);

        if (pairs.length === 0) {
          return {
            content: [{ type: "text", text: `No pairs found for: ${searchTerm || token}` }],
          };
        }

        // Format results
        const lines = pairs.map(p => {
          const price = p.priceUsd ? `$${parseFloat(p.priceUsd).toFixed(6)}` : "N/A";
          const change = p.priceChange?.h24 ? `${p.priceChange.h24 > 0 ? "+" : ""}${p.priceChange.h24.toFixed(2)}%` : "";
          const vol = p.volume?.h24 ? `$${(p.volume.h24 / 1000000).toFixed(2)}M` : "";
          const liq = p.liquidity?.usd ? `$${(p.liquidity.usd / 1000000).toFixed(2)}M liq` : "";
          const buySell = p.txns?.h24 ? `${p.txns.h24.buys}B/${p.txns.h24.sells}S` : "";

          return `${p.baseToken.symbol}/${p.quoteToken.symbol} (${p.chainId}/${p.dexId})
  Price: ${price} ${change} | Vol: ${vol} | ${liq} | Txns: ${buySell}
  Token: ${p.baseToken.address}`;
        });

        return {
          content: [{ type: "text", text: `[DexScreener - FREE]\n\n${lines.join("\n\n")}` }],
          structuredContent: { pairs, count: pairs.length },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `DexScreener error: ${errorMessage}` }],
          isError: true,
        };
      }
    }
  );
}
