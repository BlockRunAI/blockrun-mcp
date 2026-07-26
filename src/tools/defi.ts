// src/tools/defi.ts
//
// DefiLlama via BlockRun — DeFi protocol TVL, chain TVL, yield pools, and
// token prices. Path-based GET passthrough to /v1/defillama/{path}; the
// gateway proxies DefiLlama (Apache 2.0 / public commercial-use) and settles
// in USDC via x402. Endpoint catalog mirrors blockrun/src/lib/defillama.ts.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TOOL_ANNOTATIONS } from "../tool-annotations.js";
import { serializePaidRequest } from "../utils/payment-serialization.js";
import { z } from "zod";
import { reserveBudget, recordSpending } from "../utils/budget.js";
import { withTxFee } from "../utils/tx-fee.js";
import { getClient } from "../utils/wallet.js";
import { formatError, extractErrorMessage } from "../utils/errors.js";
import { hasPathTraversal } from "../utils/path-safety.js";
import type { BudgetState } from "../types.js";

type RawClient = {
  getWithPaymentRaw: (endpoint: string, params?: Record<string, string>) => Promise<unknown>;
};

// prices/* is $0.001; protocols / protocol/{slug} / chains / yields are $0.005.
function estimateDefiCost(path: string): number {
  // withTxFee: gateway charges base + $0.002 (src/utils/tx-fee.ts). Verified live:
  // defillama/protocols base $0.0050 -> charged $0.0070; prices/* $0.001 -> $0.003.
  // Reserving the base was 3x short on prices/*.
  return withTxFee(path.startsWith("prices") ? 0.001 : 0.005);
}

export function registerDefiTool(server: McpServer, budget: BudgetState): void {
  server.registerTool(
    "blockrun_defi",
    {
      description: `DeFi fundamentals via DefiLlama — protocol TVL, chain TVL, yield pools (APY), token prices. Pays per call in USDC, no API key.

Paths (GET only):
- protocols                      ($0.007 charged) — all DeFi protocols ranked by TVL
- protocol/{slug}                ($0.007 charged) — one protocol's TVL history + chain breakdown, e.g. protocol/aave-v3
- chains                         ($0.007 charged) — TVL by chain
- yields                         ($0.007 charged) — yield pools with APY + TVL (large; filter client-side)
- prices/{coins}                 ($0.003 charged) — token prices, coins like 'base:0x833589...,coingecko:ethereum'

Examples:
  blockrun_defi({ path: "protocol/uniswap-v3" })
  blockrun_defi({ path: "prices/coingecko:bitcoin,coingecko:ethereum" })
  blockrun_defi({ path: "chains" })

Use blockrun_price (free) for plain spot quotes, blockrun_dex (free) for DEX pairs, blockrun_surf for labeled on-chain data — this tool is for protocol/TVL/yield fundamentals.`,
      annotations: TOOL_ANNOTATIONS.paidPrivate,
      inputSchema: {
        path: z.string().describe("Endpoint under /v1/defillama/, e.g. 'protocols', 'protocol/aave-v3', 'chains', 'yields', 'prices/coingecko:ethereum'"),
        agent_id: z.string().optional().describe("Agent identifier for budget tracking and enforcement."),
      },
    },
    async ({ path, agent_id }) => {
      try {
        const cleanPath = path.replace(/^\/+/, "").replace(/^v1\/defillama\//, "").replace(/^api\/v1\/defillama\//, "");
        if (hasPathTraversal(cleanPath)) {
          return { content: [{ type: "text", text: formatError(`Invalid path '${path}'.`) }], isError: true };
        }
        const estimatedCost = estimateDefiCost(cleanPath);
        const gate = reserveBudget(budget, agent_id, estimatedCost);
        if (!gate.allowed) {
          return {
            content: [{ type: "text", text: `${gate.reason}. Use blockrun_wallet action:"report" to see usage or action:"delegate" to increase agent budget.` }],
            isError: true,
          };
        }
        try {
          const client = getClient() as unknown as RawClient;
          const result = await serializePaidRequest(() => client.getWithPaymentRaw(`/v1/defillama/${cleanPath}`));
          recordSpending(budget, estimatedCost, agent_id);
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            structuredContent: (typeof result === "object" && result !== null && !Array.isArray(result)
              ? result
              : { result }) as Record<string, unknown>,
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
