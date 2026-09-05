// src/tools/wallet.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BudgetState } from "../types.js";
import { getWalletInfo, getUsdcBalance, getChain, setChain, ensureBothWallets, getChainBalance, getApiBase } from "../utils/wallet.js";
import { isApiKeyMode, requireWalletMode, PORTAL_CREDITS_URL, PORTAL_ACTIVITY_URL } from "../utils/auth.js";
import { generateQrPng, openQrInViewer } from "../utils/qr.js";
import { launchTopUp } from "../utils/onramp.js";
import { formatError } from "../utils/errors.js";
import { TOOL_ANNOTATIONS } from "../tool-annotations.js";
import { appToolMeta } from "../apps.js";

export function registerWalletTool(server: McpServer, budget: BudgetState): void {
  server.registerTool(
    "blockrun_wallet",
    {
      description: `Call this tool to manage the BlockRun payment wallet and control agent spending budgets.

Call this FIRST if any other blockrun_* tool returns a payment/balance error.
Call this to check your current USDC balance before expensive operations.
Call this to set spending limits before spawning child agents.

If this server is running on a BlockRun API key (BLOCKRUN_API_KEY), there is no
wallet and no chain: status reports the account, and setup/qr/deposit/chain do
not apply. Credit is managed at https://user.blockrun.ai/dashboard/credits.

In wallet mode the server holds TWO wallets — one on Solana, one on Base — but
pays on ONE active chain at a time. status shows both addresses/balances and
which is active. New installs default to Solana; an existing Base wallet keeps
Base until you switch.

To switch chain (no env vars, no file editing, no restart):
  1. action:"chain" chain:"solana"   → provisions + activates the Solana wallet
  2. action:"setup"                   → address + funding QR for the active chain
Switch back with action:"chain" chain:"base". Almost everything now settles on
either chain; only blockrun_defi (DefiLlama) and blockrun_modal are Base-only,
plus native Anthropic (claude-*) in blockrun_chat.

Actions:
- status (default): Both wallet addresses + USDC balances, active chain, session spending
- deposit: Buy USDC with a card — mints a one-time Coinbase Onramp link and opens it in the browser (Base only; funds settle into your own wallet). Paid tools auto-open this on an out-of-funds failure; call it directly to fund up front.
- setup: Get funding instructions + QR code for the ACTIVE chain (call this when balance is 0)
- qr: Open QR code (active chain) in system viewer
- chain + chain:"base"|"solana": Switch the active payment chain (omit chain: to just see the current one)

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
      // MCP App: the wallet panel (docs/mcp-apps.md) on hosts that support it.
      _meta: appToolMeta("wallet"),
      annotations: TOOL_ANNOTATIONS.walletManagement,
      inputSchema: {
        action: z.enum(["status", "deposit", "setup", "qr", "chain", "budget", "delegate", "revoke", "report"]).optional().default("status").describe("What to do"),
        chain: z.enum(["base", "solana"]).optional().describe("Target chain for action='chain'. Omit to view the current active chain."),
        budget_action: z.enum(["set", "check", "clear"]).optional().describe("Budget action (for action='budget')"),
        budget_amount: z.number().optional().describe("Budget limit in USD (for budget_action='set')"),
        agent_id: z.string().optional().describe("Agent identifier for delegate/revoke/report actions"),
        agent_limit: z.number().optional().describe("Budget limit in USD for this agent (required for delegate action)"),
      },
    },
    async ({ action, chain: targetChain, budget_action, budget_amount, agent_id, agent_limit }) => {
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

      // ---------------------------------------------------------------------
      // Everything past this point needs a WALLET. The budget actions above
      // (delegate/revoke/report) are local bookkeeping and work on either rail.
      //
      // The guard sits here rather than inside each branch because the failure
      // it prevents is not an error message — it is ensureBothWallets() minting
      // an EVM and a Solana keypair, persisting both and mirroring them into the
      // OS keychain, for someone who pays by invoice and asked a status question.
      // ---------------------------------------------------------------------
      if (isApiKeyMode()) {
        if (action === "status") {
          const spent = `$${budget.spent.toFixed(4)} estimated${budget.limit ? ` / $${budget.limit.toFixed(2)} local limit` : ""} — ${budget.calls} calls`;
          const text = `Paying with: BlockRun account API key (no wallet, no chain)

  Endpoint: ${getApiBase()}
  Credit + real ledger: ${PORTAL_CREDITS_URL}
  Per-call activity:    ${PORTAL_ACTIVITY_URL}

This session (local estimate): ${spent}

The figure above is this server's own ESTIMATE, computed before each call so it
can enforce your budget limits. It is not the invoice. Actual usage is metered
by the account API at exact token counts and is only authoritative at the
dashboard links above.

Wallet actions (setup, qr, deposit, chain) need wallet mode — unset
BLOCKRUN_API_KEY and restart to use one.`;
          return {
            content: [{ type: "text", text }],
            structuredContent: {
              authMode: "api-key",
              endpoint: getApiBase(),
              creditsUrl: PORTAL_CREDITS_URL,
              activityUrl: PORTAL_ACTIVITY_URL,
              sessionEstimatedSpend: budget.spent,
              calls: budget.calls,
              costsAreEstimates: true,
            },
          };
        }
        return {
          content: [{ type: "text", text: requireWalletMode(`blockrun_wallet action:"${action}"`)! }],
          isError: true,
        };
      }

      // Switch / inspect the active payment chain
      if (action === "chain") {
        const both = await ensureBothWallets();
        if (targetChain && targetChain !== getChain()) {
          setChain(targetChain);
        }
        const active = getChain();
        const activeWallet = active === "solana" ? both.solana : both.base;
        const activeBalance = await getChainBalance(active, activeWallet.address);
        const balStr = activeBalance !== null ? `$${activeBalance.toFixed(6)} USDC` : "balance unavailable";
        const switched = targetChain ? `Switched active chain → ${active.toUpperCase()}.` : `Active chain: ${active.toUpperCase()}.`;
        const text = `${switched}

  Active (${active}): ${activeWallet.address}
    Balance: ${balStr}${activeBalance !== null && activeBalance < 1 ? "  (low — fund this address)" : ""}
  Base:   ${both.base.address}
  Solana: ${both.solana.address}

All blockrun_* calls now pay on ${active}. Still Base-only: blockrun_defi
(DefiLlama) and blockrun_modal — switch back with chain:"base" for those.`;
        return {
          content: [{ type: "text", text }],
          structuredContent: {
            activeChain: active,
            base: both.base.address,
            solana: both.solana.address,
            activeBalance,
          },
        };
      }

      const info = await getWalletInfo();
      // Non-null past the isApiKeyMode() guard above: only account mode has no
      // address, and it returned there. Asserted rather than assumed so that
      // moving the guard breaks the build instead of printing "null" as an
      // address in a funding QR someone is about to send USDC to.
      if (info.address === null) {
        return { content: [{ type: "text", text: requireWalletMode(`blockrun_wallet action:"${action}"`)! }], isError: true };
      }
      const address = info.address;
      const chain = getChain();

      // Handle deposit action — mint a one-time Coinbase card-onramp link and
      // open it (Base). On Solana, launchTopUp returns address/QR guidance.
      if (action === "deposit") {
        const r = await launchTopUp();
        return {
          content: [{ type: "text", text: r.note }],
          structuredContent: { onramp_url: r.url, opened: r.opened, chain, address },
        };
      }

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

SECURITY: Private key stored at ~/.blockrun/.session by default (never leaves your machine)
================================================================================`;

        return { content: [{ type: "text", text }] };
      }

      // Default: status action — show BOTH wallets, mark the active one.
      const both = await ensureBothWallets();
      const [baseBal, solBal] = await Promise.all([
        getChainBalance("base", both.base.address),
        getChainBalance("solana", both.solana.address),
      ]);
      const activeBalance = chain === "solana" ? solBal : baseBal;
      const fmt = (b: number | null) => (b !== null ? `$${b.toFixed(6)} USDC` : "unavailable");
      const explorerLabel = chain === "solana" ? "Solscan" : "Basescan";
      const mark = (c: "base" | "solana") => (c === chain ? "→" : " ");
      // A pre-0.40.1 install has an explicit ~/.blockrun/.chain that this server
      // wrote automatically on first run — and that file outranks
      // SOLANA_WALLET_KEY. 0.40.1 stopped creating it, but it cannot safely
      // DELETE existing ones: nothing distinguishes the machine-written file
      // from a genuine `action:"chain"` choice (that is precisely the
      // information the old behaviour destroyed). So say it out loud instead of
      // leaving the operator to wonder why their env var does nothing.
      const envIgnored = Boolean(process.env.SOLANA_WALLET_KEY) && chain === "base";
      const envNote = envIgnored
        ? `\n\n⚠️  SOLANA_WALLET_KEY is set but the active chain is BASE — a stored chain preference outranks it. Run action:"chain" chain:"solana" to switch (that also clears the stored preference).`
        : "";
      const text = `Active chain: ${chain.toUpperCase()}   (switch with action:"chain" chain:"base"|"solana")

${mark("base")} Base:   ${both.base.address}
            ${fmt(baseBal)}${baseBal !== null && baseBal < 1 ? "  (low)" : ""}
${mark("solana")} Solana: ${both.solana.address}
            ${fmt(solBal)}${solBal !== null && solBal < 1 ? "  (low)" : ""}

Paying on ${chain} | View active: ${info.explorerUrl}${info.isNew ? "\nNEW WALLET on active chain — run action:'setup' for funding instructions" : ""}${envNote}`;

      return {
        content: [{ type: "text", text }],
        structuredContent: {
          activeChain: chain,
          address: info.address,
          balance: activeBalance,
          network: info.network,
          chainId: info.chainId,
          isNew: info.isNew,
          explorerUrl: info.explorerUrl,
          explorerLabel,
          wallets: {
            base: { address: both.base.address, balance: baseBal },
            solana: { address: both.solana.address, balance: solBal },
          },
        },
      };
    }
  );
}
