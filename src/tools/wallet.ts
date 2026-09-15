// src/tools/wallet.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BudgetState } from "../types.js";
import { getWalletInfo, getUsdcBalance, getChain, setChain, ensureBothWallets, getChainBalance, getApiBase } from "../utils/wallet.js";
import { isApiKeyMode, requireWalletMode, PORTAL_CREDITS_URL, PORTAL_ACTIVITY_URL } from "../utils/auth.js";
import { describeBlock, formatCredit, getAccountCredit } from "../utils/account.js";
import { generateQrPng, openQrInViewer } from "../utils/qr.js";
import { launchTopUp } from "../utils/onramp.js";
import { formatError } from "../utils/errors.js";
import { delegateAgent, listRevokedAgents, revokeAgent, sealOperatorCeiling } from "../utils/budget.js";
import { TOOL_ANNOTATIONS } from "../tool-annotations.js";
import { appToolMeta } from "../apps.js";

export function registerWalletTool(server: McpServer, budget: BudgetState): void {
  // The limit this ledger was BORN with is the operator's BLOCKRUN_BUDGET_LIMIT
  // (initializeMcpServer seeds it from the env and registers tools right
  // after). It is sealed here, before the model can call anything, and the
  // budget/delegate branches below treat it as a ceiling the session may
  // lower but never clear or exceed — see budget.ts for the failure this
  // prevents. Null means the server started unlimited and set/clear keep
  // their original, unrestricted meaning.
  const ceiling = sealOperatorCeiling(budget);
  const ceilingStr = ceiling !== null ? `$${ceiling.toFixed(2)}` : null;
  const restartHint = `Only a restart with a higher BLOCKRUN_BUDGET_LIMIT raises it.`;

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
- budget + budget_action:"check" (the default) → Report the cap, spend and remaining
- budget + budget_action:"clear" → Remove a cap set here
If the operator started the server with BLOCKRUN_BUDGET_LIMIT, that value is a
ceiling this tool can only lower: set above it is clamped, clear restores it,
and agent_limit is clamped to it. Only a restart with a new env raises it.

Multi-agent orchestration:
- delegate + agent_id:"research" + agent_limit:2.00 → Allocate $2 to a child agent
- revoke + agent_id:"research" → Remove a child agent's cap (its spend is kept; re-delegating the id carries it)
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
        budget_action: z.enum(["set", "check", "clear"]).optional().describe("Budget action (for action='budget'). Defaults to 'check', which only reports."),
        budget_amount: z.number().optional().describe("Budget limit in USD (for budget_action='set')"),
        agent_id: z.string().optional().describe("Agent identifier for delegate/revoke/report actions"),
        agent_limit: z.number().optional().describe("Budget limit in USD for this agent (required for delegate action)"),
      },
    },
    async ({ action, chain: targetChain, budget_action, budget_amount, agent_id, agent_limit }) => {
      // Handle budget action
      if (action === "budget") {
        const budgetAct = budget_action || "check";
        // What the call did, in the model's own terms. A clamp or a restored
        // ceiling is NOT an error — the state changed, just not to what was
        // asked — but the reason has to be in the text, because the next thing
        // an agent does after "Set to $2.00" when it asked for $1000 is ask
        // again.
        let outcome = "";
        let clamped = false;

        if (budgetAct === "set") {
          if (budget_amount === undefined || budget_amount <= 0) {
            return {
              content: [{ type: "text", text: "Error: Provide a positive budget_amount (e.g., 1.00 for $1.00)" }],
              isError: true,
            };
          }
          if (ceiling !== null && budget_amount > ceiling) {
            clamped = true;
            budget.limit = ceiling;
            outcome = ` | Requested $${budget_amount.toFixed(2)}, clamped to ${ceilingStr}: the operator set BLOCKRUN_BUDGET_LIMIT=${ceilingStr} as this process's ceiling and it cannot be raised from inside the session. ${restartHint}`;
          } else {
            budget.limit = budget_amount;
            outcome = ` | Set to $${budget_amount.toFixed(2)}`;
          }
        } else if (budgetAct === "clear") {
          if (ceiling !== null) {
            budget.limit = ceiling;
            outcome = ` | Restored to the operator ceiling ${ceilingStr} (BLOCKRUN_BUDGET_LIMIT); that cap cannot be removed from inside the session. ${restartHint}`;
          } else {
            budget.limit = null;
            outcome = " | Limit removed";
          }
        } else if (ceiling !== null) {
          outcome = ` | Ceiling: ${ceilingStr} (BLOCKRUN_BUDGET_LIMIT, operator-set; this tool can only lower it)`;
        }

        const remaining = budget.limit !== null ? budget.limit - budget.spent : null;
        const limitStr = budget.limit !== null ? `$${budget.limit.toFixed(2)}` : "Unlimited";
        const remainingStr = remaining !== null ? `$${remaining.toFixed(4)}` : "N/A";

        return {
          content: [{ type: "text", text: `Session Budget: ${limitStr} | Spent: $${budget.spent.toFixed(4)} | Calls: ${budget.calls} | Remaining: ${remainingStr}${outcome}` }],
          structuredContent: {
            limit: budget.limit,
            ceiling,
            clamped,
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
        // A child's cap cannot exceed the operator's. The global cap would
        // stop the spend anyway; what a $50 allocation under a $2 ceiling
        // gets wrong is the REPORT — an agent told it has $48 remaining plans
        // for $48.
        const requested = agent_limit;
        const limit = ceiling !== null && agent_limit > ceiling ? ceiling : agent_limit;
        // Carry the LEDGER across a re-delegation (and across a revoke — see
        // delegateAgent). This used to write `spent: 0` unconditionally, so an
        // agent that had exhausted its cap could refill itself by calling
        // delegate again with the same id — and delegate is a tool the model
        // can call. A limit is a policy the operator may raise or lower at
        // will; spend already happened and is not the operator's to erase.
        // The entry is mutated in place rather than replaced: a paid call
        // that reserved against it before this re-delegation must release
        // against the same object afterwards, or the estimate is stranded on
        // the ledger for the rest of the process.
        const { entry, carried } = delegateAgent(budget, agent_id, limit);
        const { spent, calls } = entry;
        // USDC has six decimals, and float subtraction does not: 1 - 0.9 is
        // 0.09999999999999998, which would surface verbatim in the report and
        // in structuredContent. Round the DERIVED figure; `spent` stays exact.
        const remaining = Math.round(Math.max(0, limit - spent) * 1e6) / 1e6;
        const lines = [`Agent "${agent_id}" allocated $${limit.toFixed(2)} budget.`];
        if (limit !== requested) {
          lines.push(
            `Requested $${requested.toFixed(2)}, clamped to ${ceilingStr}: the operator set BLOCKRUN_BUDGET_LIMIT=${ceilingStr} ` +
            `as this process's ceiling and no agent can be allocated more than that. ${restartHint}`,
          );
        }
        if (carried) {
          lines.push(
            `Carried over from the previous allocation: $${spent.toFixed(4)} spent across ${calls} call${calls === 1 ? "" : "s"} — ` +
            `$${remaining.toFixed(4)} remains under the new limit.` +
            (remaining === 0 ? ` This agent is already at its cap; raise agent_limit above $${spent.toFixed(4)} to give it room.` : ""),
          );
        }
        if (budget.limit !== null && limit > budget.limit) {
          lines.push(`Note: the session cap is $${budget.limit.toFixed(2)}, so this agent cannot actually spend more than that.`);
        }
        lines.push(`Pass agent_id: "${agent_id}" in any blockrun_* tool call to track and enforce this limit.`);
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          structuredContent: { agent_id, limit, spent, calls, remaining },
        };
      }

      // Revoke: remove an agent's cap. The ledger is kept — revoke + delegate
      // is two model-callable calls, and letting them reset `spent` would be
      // the refill the carry-over above exists to prevent.
      if (action === "revoke") {
        if (!agent_id) {
          return { content: [{ type: "text", text: formatError("agent_id required for revoke action") }], isError: true };
        }
        const existed = revokeAgent(budget, agent_id);
        return {
          content: [{ type: "text", text: existed ? `Agent "${agent_id}" budget revoked.` : `Agent "${agent_id}" had no budget entry.` }],
          structuredContent: { agent_id, revoked: existed },
        };
      }

      // Report: show spending breakdown by agent
      if (action === "report") {
        const agentRows: Record<string, { limit: number | null; spent: number; calls: number; remaining: number | null; revoked?: true }> = {};
        for (const [id, ab] of budget.agents.entries()) {
          agentRows[id] = {
            limit: ab.limit,
            spent: ab.spent,
            calls: ab.calls,
            remaining: Math.max(0, ab.limit - ab.spent),
          };
        }
        // Revoked ids keep their ledger (the next delegate carries it); the
        // report shows it, because "its spend is kept" is what the
        // description promises and a tombstone nobody can read is not kept.
        for (const [id, ab] of listRevokedAgents(budget)) {
          if (!(id in agentRows)) agentRows[id] = { limit: null, spent: ab.spent, calls: ab.calls, remaining: null, revoked: true };
        }
        const agentLines = Object.entries(agentRows).map(
          ([id, ab]) => ab.revoked
            ? `  ${id}: $${ab.spent.toFixed(4)} (${ab.calls} calls, revoked — no cap; re-delegating carries this spend)`
            : `  ${id}: $${ab.spent.toFixed(4)}/$${(ab.limit as number).toFixed(2)} (${ab.calls} calls, $${(ab.remaining as number).toFixed(4)} remaining)`
        );
        const lines = [
          `Global: $${budget.spent.toFixed(4)} spent${budget.limit ? ` / $${budget.limit.toFixed(2)} limit` : " (no limit)"} — ${budget.calls} calls${ceiling !== null ? ` (operator ceiling ${ceilingStr} via BLOCKRUN_BUDGET_LIMIT)` : ""}`,
          ``,
          `Per-agent budgets (${budget.agents.size} active):`,
          ...(agentLines.length > 0 ? agentLines : ["  (none delegated)"]),
        ];
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          structuredContent: { global: { limit: budget.limit, ceiling, spent: budget.spent, calls: budget.calls }, agents: agentRows },
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
          // Read the REAL balance. This used to print only a local estimate and
          // a link, because no key-authenticated endpoint existed; GET /v1/credits
          // closed that on 2026-09-05. A read failure degrades to the session
          // figure rather than failing the whole status call — knowing nothing
          // about the account is not a reason to also refuse to say what this
          // process has spent.
          let credit: Awaited<ReturnType<typeof getAccountCredit>> | null = null;
          let creditError: string | null = null;
          try {
            credit = await getAccountCredit();
          } catch (err) {
            creditError = err instanceof Error ? err.message : String(err);
          }
          const blockNote = credit ? describeBlock(credit.blocked ? credit.blockedReason : null) : null;
          const session = `$${budget.spent.toFixed(4)}${budget.limit ? ` / $${budget.limit.toFixed(2)} local cap` : ""} — ${budget.calls} calls`;
          const text = [
            `Paying with: BlockRun account API key (no wallet, no chain)`,
            ``,
            credit
              ? `  Account:  ${credit.accountId} (${credit.billingMode})\n  ${formatCredit(credit)}`
              : `  Account credit unavailable: ${creditError}`,
            `  Top up:   ${PORTAL_CREDITS_URL}`,
            `  Activity: ${PORTAL_ACTIVITY_URL}`,
            ``,
            `This session: ${session}`,
            ...(blockNote ? [``, `BLOCKED — ${blockNote}`] : []),
            ``,
            `Per-call costs are the amount the account API actually settled, where it`,
            `reports one. Chat settles after the response by design, so chat figures`,
            `stay estimates; the ledger above is always authoritative.`,
            ``,
            `Wallet actions (setup, qr, deposit, chain) need wallet mode — unset`,
            `BLOCKRUN_API_KEY and restart to use one.`,
          ].join("\n");
          return {
            content: [{ type: "text", text }],
            structuredContent: {
              authMode: "api-key",
              endpoint: getApiBase(),
              creditsUrl: PORTAL_CREDITS_URL,
              activityUrl: PORTAL_ACTIVITY_URL,
              sessionSpend: budget.spent,
              calls: budget.calls,
              ...(credit
                ? {
                    accountId: credit.accountId,
                    billingMode: credit.billingMode,
                    grantedUsd: credit.grantedUsd,
                    spentUsd: credit.spentUsd,
                    remainingUsd: credit.remainingUsd,
                    blocked: credit.blocked,
                    blockedReason: credit.blockedReason,
                  }
                : { creditError }),
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
      // The description promises "session spending" from status, and tells
      // the model to check here before an expensive call. The balance alone
      // answers "can the wallet pay?" — not "am I still inside my cap?", which
      // is the question an agent on a $1 allotment is actually asking. Same
      // line and fields as the api-key branch, so a client renders one shape.
      const session = `$${budget.spent.toFixed(4)}${budget.limit ? ` / $${budget.limit.toFixed(2)} local cap` : ""} — ${budget.calls} calls`;
      const text = `Active chain: ${chain.toUpperCase()}   (switch with action:"chain" chain:"base"|"solana")

${mark("base")} Base:   ${both.base.address}
            ${fmt(baseBal)}${baseBal !== null && baseBal < 1 ? "  (low)" : ""}
${mark("solana")} Solana: ${both.solana.address}
            ${fmt(solBal)}${solBal !== null && solBal < 1 ? "  (low)" : ""}

This session: ${session}
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
          sessionSpend: budget.spent,
          calls: budget.calls,
          limit: budget.limit,
          wallets: {
            base: { address: both.base.address, balance: baseBal },
            solana: { address: both.solana.address, balance: solBal },
          },
        },
      };
    }
  );
}
