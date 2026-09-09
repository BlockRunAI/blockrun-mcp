// src/tools/dex.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TOOL_ANNOTATIONS } from "../tool-annotations.js";
import { z } from "zod";
import { fetchWithTimeout } from "../utils/http.js";

/**
 * What DexScreener's `/latest/dex/tokens/{addresses}` accepts: one or more
 * (up to 30, comma-separated) token addresses — 0x…40-hex on EVM chains,
 * base58 on Solana, and the longer forms other chains use (Sui coin types like
 * `0x2::sui::SUI`, TON, Aptos). Rather than enumerate those per chain, allow
 * the characters addresses are made of and nothing that URL syntax gives a
 * meaning to: no `/ ? # % & +`, no whitespace, and no segment that starts with
 * a dot (so `.` and `..` cannot travel up the path). `:` is a legal path
 * character (RFC 3986 pchar), so no percent-encoding is needed once the shape
 * is enforced.
 */
const TOKEN_ADDRESS_RE = /^[A-Za-z0-9][A-Za-z0-9_:.-]{1,199}$/;
const MAX_TOKEN_ADDRESSES = 30;

/**
 * Split and validate the `token` argument. Returns the cleaned addresses, or
 * null when any item fails the shape check. Exported for tests.
 */
export function parseTokenAddresses(raw: string): string[] | null {
  const items = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  if (items.length === 0 || items.length > MAX_TOKEN_ADDRESSES) return null;
  return items.every((s) => TOKEN_ADDRESS_RE.test(s)) ? items : null;
}

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
      annotations: TOOL_ANNOTATIONS.readOnlyOpenWorld,
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
          // The caller's string goes into the URL PATH. Validate the shape
          // instead of splicing it raw: `../search?q=pepe` or `abc#x` would
          // otherwise rewrite the request and return another endpoint's
          // answer (or nothing) labelled as token data.
          const addresses = parseTokenAddresses(token);
          if (!addresses) {
            return {
              content: [{
                type: "text",
                text:
                  `Invalid token address: ${JSON.stringify(token)}. Expected a contract or mint address ` +
                  `(0x… on EVM chains, base58 on Solana), or up to ${MAX_TOKEN_ADDRESSES} of them separated by commas. ` +
                  `To search by name or symbol use query instead.`,
              }],
              isError: true,
            };
          }
          url = `https://api.dexscreener.com/latest/dex/tokens/${addresses.join(",")}`;
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
