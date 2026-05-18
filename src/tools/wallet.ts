// src/tools/wallet.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BudgetState } from "../types.js";
import { getWalletInfo, getUsdcBalance, getChain } from "../utils/wallet.js";
import { generateQrPng, openQrInViewer } from "../utils/qr.js";
import { formatError } from "../utils/errors.js";

export function registerWalletTool(server: McpServer, budget: BudgetState): void {
  server.registerTool(
    "blockrun_wallet",
    {
      description: `Call this tool to manage the BlockRun payment wallet and control agent spending budgets.

Call this FIRST if any other blockrun_* tool returns a payment/balance error.
Call this to check your current USDC balance before expensive operations.
Call this to set spending limits before spawning child agents.

Actions:
- status (default): Current wallet address, USDC balance, total session spending
- setup: Get funding instructions + QR code (call this when balance is 0)
- qr: Open QR code in system viewer

Budget controls:
- budget + budget_action:"set" + budget_amount:1.00 → Set global spend cap
- budget + budget_action:"clear" → Remove global spend cap

Multi-agent orchestration:
- delegate + agent_id:"research" + agent_limit:2.00 → Allocate $2 to a child agent
- revoke + agent_id:"research" → Remove a child agent's budget
- report → See per-agent spending breakdown

Usage pattern for multi-agent systems:
  1. blockrun_wallet action:"delegate" agent_id:"worker-1" agent_limit:1.00
  2. Pass agent_id:"worker-1" to all blockrun_chat/search/etc calls for that agent
  3. blockrun_wallet action:"report" to audit spending

Do NOT call this for actual AI queries — use blockrun_chat for that.`,
      inputSchema: {
        action: z.enum(["status", "setup", "qr", "budget", "delegate", "revoke", "report"]).optional().default("status").describe("What to do"),
        budget_action: z.enum(["set", "check", "clear"]).optional().describe("Budget action (for action='budget')"),
        budget_amount: z.number().optional().describe("Budget limit in USD (for budget_action='set')"),
        agent_id: z.string().optional().describe("Agent identifier for delegate/revoke/report actions"),
        agent_limit: z.number().optional().describe("Budget limit in USD for this agent (required for delegate action)"),
      },
    },
    async ({ action, budget_action, budget_amount, agent_id, agent_limit }) => {
      // Handle budget action
      if (action === "budget") {
        const budgetAct = budget_action || "check";

        if (budgetAct === "set") {
          if (budget_amount === undefined || budget_amount <= 0) {
            return {
              content: [{ type: "text", text: "Error: Provide a positive budget_amount (e.g., 1.00 for $1.00)" }],
              isError: true,
            };
          }
          budget.limit = budget_amount;
        } else if (budgetAct === "clear") {
          budget.limit = null;
        }

        const remaining = budget.limit !== null ? budget.limit - budget.spent : null;
        const limitStr = budget.limit !== null ? `$${budget.limit.toFixed(2)}` : "Unlimited";
        const remainingStr = remaining !== null ? `$${remaining.toFixed(4)}` : "N/A";

        return {
          content: [{ type: "text", text: `Session Budget: ${limitStr} | Spent: $${budget.spent.toFixed(4)} | Calls: ${budget.calls} | Remaining: ${remainingStr}${budgetAct === "set" ? ` | Set to $${budget_amount?.toFixed(2)}` : ""}${budgetAct === "clear" ? " | Limit removed" : ""}` }],
          structuredContent: {
            limit: budget.limit,
            spent: budget.spent,
            calls: budget.calls,
            remaining,
          },
        };
      }

      // Delegate: allocate budget to a named agent
      if (action === "delegate") {
        if (!agent_id) {
          return { content: [{ type: "text", text: formatError("agent_id required for delegate action") }], isError: true };
        }
        if (!agent_limit || agent_limit <= 0) {
          return { content: [{ type: "text", text: formatError("agent_limit (USD > 0) required for delegate action") }], isError: true };
        }
        budget.agents.set(agent_id, { limit: agent_limit, spent: 0, calls: 0 });
        return {
          content: [{ type: "text", text: `Agent "${agent_id}" allocated $${agent_limit.toFixed(2)} budget.\nPass agent_id: "${agent_id}" in any blockrun_* tool call to track and enforce this limit.` }],
          structuredContent: { agent_id, limit: agent_limit, spent: 0, calls: 0 },
        };
      }

      // Revoke: remove an agent's budget allocation
      if (action === "revoke") {
        if (!agent_id) {
          return { content: [{ type: "text", text: formatError("agent_id required for revoke action") }], isError: true };
        }
        const existed = budget.agents.has(agent_id);
        budget.agents.delete(agent_id);
        return {
          content: [{ type: "text", text: existed ? `Agent "${agent_id}" budget revoked.` : `Agent "${agent_id}" had no budget entry.` }],
          structuredContent: { agent_id, revoked: existed },
        };
      }

      // Report: show spending breakdown by agent
      if (action === "report") {
        const agentRows: Record<string, { limit: number; spent: number; calls: number; remaining: number }> = {};
        for (const [id, ab] of budget.agents.entries()) {
          agentRows[id] = {
            limit: ab.limit,
            spent: ab.spent,
            calls: ab.calls,
            remaining: Math.max(0, ab.limit - ab.spent),
          };
        }
        const agentLines = Object.entries(agentRows).map(
          ([id, ab]) => `  ${id}: $${ab.spent.toFixed(4)}/$${ab.limit.toFixed(2)} (${ab.calls} calls, $${ab.remaining.toFixed(4)} remaining)`
        );
        const lines = [
          `Global: $${budget.spent.toFixed(4)} spent${budget.limit ? ` / $${budget.limit.toFixed(2)} limit` : " (no limit)"} — ${budget.calls} calls`,
          ``,
          `Per-agent budgets (${budget.agents.size} active):`,
          ...(agentLines.length > 0 ? agentLines : ["  (none delegated)"]),
        ];
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          structuredContent: { global: { limit: budget.limit, spent: budget.spent, calls: budget.calls }, agents: agentRows },
        };
      }

      const info = await getWalletInfo();
      const address = info.address;
      const chain = getChain();

      // Handle QR action
      if (action === "qr") {
        try {
          const qrPath = await generateQrPng(address, chain);
          await openQrInViewer(qrPath);
          const scanNote = chain === "solana"
            ? "Scan with a Solana wallet (Phantom, Solflare) to send USDC on Solana."
            : "Scan with MetaMask to send USDC on Base.";
          return {
            content: [{ type: "text", text: `QR code opened! ${scanNote}\n\nAddress: ${address}\nQR saved: ${qrPath}` }],
          };
        } catch (err) {
          return {
            content: [{ type: "text", text: `Failed to generate QR: ${err}` }],
            isError: true,
          };
        }
      }

      // Handle setup action
      if (action === "setup") {
        let qrMessage = "";
        try {
          const qrPath = await generateQrPng(address, chain);
          await openQrInViewer(qrPath);
          qrMessage = `\nQR code opened for scanning! (${qrPath})`;
        } catch {
          qrMessage = "\n(QR generation failed - use address above)";
        }

        const text = chain === "solana"
          ? `
================================================================================
                        BLOCKRUN WALLET SETUP (SOLANA)
================================================================================

Your Solana wallet address: ${address}
${qrMessage}

HOW TO FUND YOUR WALLET:
------------------------

Option 1: Transfer from Coinbase
  1. Open Coinbase app or website
  2. Go to Send/Receive → Select USDC
  3. Choose "Solana" network (important!)
  4. Paste: ${address}
  5. Send $1-5 to start

Option 2: Transfer from any Solana wallet (Phantom, Solflare, Backpack)
  - Send USDC (SPL) to: ${address}
  - Make sure to use Solana network, not EVM

Option 3: Bridge from other chains
  https://portalbridge.com → Bridge USDC to Solana → Send to address above

VERIFY BALANCE: https://solscan.io/account/${address}

PRICING (pay per use):
  - GPT-4o: ~$0.005/request | Claude Sonnet: ~$0.003/request
  - Gemini Flash: ~$0.0001/request | Full pricing: https://blockrun.ai/pricing

SECURITY: Private key stored at ~/.blockrun/.solana-session (never leaves your machine)
================================================================================`
          : `
================================================================================
                        BLOCKRUN WALLET SETUP
================================================================================

Your wallet address: ${address}
${qrMessage}

HOW TO FUND YOUR WALLET:
------------------------

Option 1: Transfer from Coinbase
  1. Open Coinbase app or website
  2. Go to Send/Receive -> Select USDC
  3. Choose "Base" network (important!)
  4. Paste: ${address}
  5. Send $1-5 to start

Option 2: Bridge from other chains
  https://bridge.base.org -> Bridge USDC to Base -> Send to address above

Option 3: Buy directly
  https://www.coinbase.com/onramp -> Buy USDC on Base -> Send to address above

VERIFY BALANCE: https://basescan.org/address/${address}

PRICING (pay per use):
  - GPT-4o: ~$0.005/request | Claude Sonnet: ~$0.003/request
  - Gemini Flash: ~$0.0001/request | Full pricing: https://blockrun.ai/pricing

SECURITY: Private key stored at ~/.blockrun/.session (never leaves your machine)
================================================================================`;

        return { content: [{ type: "text", text }] };
      }

      // Default: status action
      const balance = await getUsdcBalance(address);
      const balanceStr = balance !== null ? `$${balance.toFixed(6)} USDC` : "Unable to fetch";
      const lowBalance = balance !== null && balance < 1;

      const explorerLabel = chain === "solana" ? "Solscan" : "Basescan";
      const text = `Wallet: ${address}
Balance: ${balanceStr}${lowBalance ? " (low - add funds)" : ""}
Network: ${info.network} | View: ${info.explorerUrl}
${info.isNew ? "\nNEW WALLET - Run with action: 'setup' for funding instructions" : ""}`;

      return {
        content: [{ type: "text", text }],
        structuredContent: {
          address: info.address,
          balance,
          network: info.network,
          chainId: info.chainId,
          isNew: info.isNew,
          explorerUrl: info.explorerUrl,
          explorerLabel,
        },
      };
    }
  );
}
