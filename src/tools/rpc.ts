// src/tools/rpc.ts
//
// Multi-chain JSON-RPC via BlockRun's Tatum-backed gateway. Path-based
// passthrough: POST /v1/rpc/{network} with a standard JSON-RPC 2.0 body.
// 40+ chains, flat $0.002 per call (a JSON-RPC batch charges per element).
// Unknown-but-wellformed network slugs pass through to the Tatum gateway,
// so newly added chains work without an MCP release. Full network catalog
// and per-chain method examples live in the `rpc` skill.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { reserveBudget, recordSpending } from "../utils/budget.js";
import { coerceBody } from "../utils/body.js";
import { getClient } from "../utils/wallet.js";
import { formatError, extractErrorMessage } from "../utils/errors.js";
import { isValidNetworkSlug } from "../utils/path-safety.js";
import type { BudgetState } from "../types.js";

type RawClient = {
  requestWithPaymentRaw: (endpoint: string, body: unknown) => Promise<unknown>;
};

const RPC_PRICE_USD = 0.002;

export function registerRpcTool(server: McpServer, budget: BudgetState): void {
  server.registerTool(
    "blockrun_rpc",
    {
      description: `Raw JSON-RPC against 40+ blockchains — one endpoint, no node, no API key. $0.002 per call (batch charges per element).

Use when you need data the higher-level tools don't cover: contract reads (eth_call), balances, blocks, txs, logs, gas, or any chain-native RPC method.

Networks (full catalog in the rpc skill): ethereum, base, arbitrum, optimism, polygon, bsc, avalanche, solana, bitcoin, sui, near, ripple, polkadot, dogecoin, litecoin, monad, berachain, unichain, hyperevm, sonic, and 20+ more.

Examples:
  blockrun_rpc({ network: "ethereum", method: "eth_blockNumber" })
  blockrun_rpc({ network: "base", method: "eth_getBalance", params: ["0xabc...", "latest"] })
  blockrun_rpc({ network: "solana", method: "getSlot" })
  blockrun_rpc({ network: "bitcoin", method: "getblockchaininfo" })
  blockrun_rpc({ network: "ethereum", body: [{jsonrpc:"2.0",id:1,method:"eth_blockNumber"},{...}] })  // batch

Prefer blockrun_price (free quotes), blockrun_dex (free DEX data), or blockrun_surf (labeled/aggregated data) when they cover the question — this tool is for raw chain access.`,
      inputSchema: {
        network: z.string().describe("Chain key, e.g. 'ethereum', 'base', 'solana', 'bitcoin', 'arbitrum', 'polygon'. Unknown slugs pass through to the Tatum gateway."),
        method: z.string().optional().describe("JSON-RPC method, e.g. 'eth_blockNumber', 'eth_call', 'getSlot' (Solana), 'getblockchaininfo' (Bitcoin). Required unless 'body' is set."),
        params: z.any().optional().describe("JSON-RPC params array for the method, e.g. ['0xabc...', 'latest']."),
        body: z.any().optional().describe("Full JSON-RPC 2.0 body or an array of them (batch). Overrides method/params when set."),
        agent_id: z.string().optional().describe("Agent identifier for budget tracking and enforcement."),
      },
    },
    async ({ network, method, params, body, agent_id }) => {
      try {
        body = coerceBody(body);
        if (body === undefined) {
          if (!method) {
            return {
              content: [{ type: "text", text: formatError("Provide either 'method' (with optional 'params') or a full JSON-RPC 'body'.") }],
              isError: true,
            };
          }
          body = { jsonrpc: "2.0", id: 1, method, params: params ?? [] };
        }

        const batchCount = Array.isArray(body) ? Math.max(body.length, 1) : 1;
        const estimatedCost = RPC_PRICE_USD * batchCount;

        const cleanNetwork = network.trim().toLowerCase().replace(/^\/+|\/+$/g, "");
        // A chain slug never contains '/', '.', or '..'. Reject anything else so
        // a `network` like "../chat/completions" can't normalize past /v1/rpc/
        // and re-route a cheap RPC call onto an expensive paid endpoint.
        if (!isValidNetworkSlug(cleanNetwork)) {
          return {
            content: [{ type: "text", text: formatError(`Invalid network '${network}'. Use a chain slug like 'ethereum', 'base', or 'solana'.`) }],
            isError: true,
          };
        }

        const gate = reserveBudget(budget, agent_id, estimatedCost);
        if (!gate.allowed) {
          return {
            content: [{ type: "text", text: `${gate.reason}. Use blockrun_wallet action:"report" to see usage or action:"delegate" to increase agent budget.` }],
            isError: true,
          };
        }
        try {
          const client = getClient() as unknown as RawClient;
          const result = await client.requestWithPaymentRaw(`/v1/rpc/${cleanNetwork}`, body);
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
