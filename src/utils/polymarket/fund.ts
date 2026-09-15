// src/utils/polymarket/fund.ts
//
// action:"fund" — top up the Polymarket deposit wallet from the agent's OWN Base
// USDC, gaslessly, in one call. NON-CUSTODIAL: the agent signs an EIP-3009
// authorization transferring USDC (Base) DIRECTLY to the Polymarket bridge
// address for its vault; BlockRun's /v1/polymarket/fund endpoint hands it to the
// CDP facilitator (which broadcasts + pays gas) and charges a $0.01 fee. The
// principal never touches a BlockRun wallet — it goes agent → bridge → vault
// (wrapped to pUSD). The agent needs ZERO Base ETH for gas.
import axios from "axios";
import type { Hex } from "viem";
import { BlockrunClient, createPaymentPayload } from "@blockrun/llm";
import { getOrCreateWalletKey, getChainBalance } from "../wallet.js";
import { getPolymarketAccount } from "./client.js";
import { BASE_CHAIN_ID, BRIDGE_API_HOST, getMaxFundUsd, getSigType } from "./constants.js";
import { getFundsAddress } from "./positions.js";
import { getPublicClient } from "./setup.js";
import { loadState, saveState } from "./creds.js";
import { declinedResult, type SpendGate, type ToolResult } from "./transactions.js";
import type { BudgetState } from "../../types.js";
import { recordActualSpend, reserveBudget } from "../budget.js";

const FUND_FEE_USD = 0.01;
const USDC_DECIMALS = 6;
/**
 * How long the signed EIP-3009 authorization stays executable, in seconds.
 * Passed to createPaymentPayload explicitly (its default is the same 300s) so
 * the pendingFund deadline below and the signature's validBefore cannot drift.
 * Exported for tests.
 */
export const FUND_AUTH_VALIDITY_SECS = 300;
/** The facilitator can broadcast right at validBefore; don't race it. */
const FUND_GUARD_GRACE_SECS = 60;

const FUND_GUIDANCE =
  "check your Base wallet's USDC balance (blockrun_wallet action:\"status\", or basescan) and the vault's pUSD " +
  "with action:\"setup\" before ANY retry — a resubmitted funding call signs a SECOND full transfer and can double-send";

/**
 * True when a thrown gateway error PROVES the deposit authorization was never
 * forwarded: a 4xx from @blockrun/llm's APIError (`statusCode`), or its
 * PaymentError (the x402 FEE payment was refused before the request body was
 * processed). A timeout, a dropped socket, a 5xx, or a success:false body all
 * arrive after the gateway may have handed the authorization to the
 * facilitator — outcome unknown.
 */
function isDefiniteFundRejection(err: unknown): boolean {
  const e = err as { name?: string; statusCode?: unknown } | undefined;
  if (e?.name === "PaymentError") return true;
  return typeof e?.statusCode === "number" && e.statusCode >= 400 && e.statusCode < 500;
}
// The Polymarket bridge does NOT process Base-USDC deposits below this — a
// smaller amount lands at the bridge address but is never wrapped/delivered to
// the vault (verified live: a $0.10 deposit confirmed on Base but never reached
// the vault). Override with POLYMARKET_FUND_MIN_USD if the bridge minimum moves.
const FUND_MIN_USD = Number(process.env.POLYMARKET_FUND_MIN_USD || "2");

/** Bridge deposit address for a Polymarket vault (delivers pUSD to the vault). */
async function bridgeAddressFor(vault: string): Promise<string> {
  const res = await axios.post(
    `${BRIDGE_API_HOST}/deposit`,
    { address: vault },
    { headers: { "content-type": "application/json" }, timeout: 20_000 },
  );
  const evm = (res.data as { address?: { evm?: string } })?.address?.evm;
  if (!evm) throw new Error(`Bridge did not return a deposit address (got: ${JSON.stringify(res.data)}).`);
  return evm;
}

export async function fundVault(input: {
  amount_usd?: number;
  confirm?: boolean;
  askUser?: SpendGate;
  /**
   * The x402 budget ledger. The DEPOSIT is the user's own USDC into a vault
   * only the same key controls and stays outside the ledger, but the $0.01
   * gateway fee is BlockRun API spend from the Base wallet — the thing the
   * ledger meters. Absent (legacy wiring), the fee is neither reserved nor
   * booked, as before.
   */
  budget?: BudgetState;
  agent_id?: string;
}): Promise<ToolResult> {
  if (input.amount_usd === undefined || input.amount_usd <= 0) {
    return { text: `Pass amount_usd — the USDC amount to move from your Base wallet into your Polymarket vault (e.g. amount_usd:5).`, isError: true };
  }
  if (input.amount_usd < FUND_MIN_USD) {
    return {
      text: `Minimum funding is $${FUND_MIN_USD} — the Polymarket bridge does not process smaller Base-USDC deposits ` +
        `(a smaller amount would confirm on Base but never wrap to pUSD in your vault). Use amount_usd ≥ ${FUND_MIN_USD}.`,
      isError: true,
    };
  }
  // Optional per-call ceiling. fund signs an EIP-3009 authorization for the
  // FULL amount outside the x402 budget ledger and outside the order caps
  // (POLYMARKET_MAX_BET_USD gates executeTrade only). Default: no cap — this is
  // the user's own Base USDC into a vault only the same key controls. Checked
  // before any RPC/bridge call so the dry-run reports the refusal too.
  const maxFund = getMaxFundUsd();
  if (maxFund !== null && input.amount_usd > maxFund) {
    return {
      text: `Refusing to fund $${input.amount_usd.toFixed(2)}: POLYMARKET_MAX_FUND_USD caps a single funding call at ` +
        `$${maxFund.toFixed(2)}. Nothing moved. Fund in smaller calls, or raise/unset the cap if the operator intends it.`,
      isError: true,
    };
  }
  const amountUsd = input.amount_usd;

  let vault: Hex;
  try {
    vault = getFundsAddress();
  } catch (err) {
    return { text: err instanceof Error ? err.message : String(err), isError: true };
  }
  const agent = getPolymarketAccount().address;

  try {
    // The deposit wallet must be DEPLOYED before funding: the bridge delivers
    // pUSD to the vault contract, and it can't credit a vault that doesn't
    // exist on-chain yet (verified live — funding an undeployed vault let the
    // bridge sweep the USDC but never deliver pUSD). Correct order is
    // setup(deploy) → fund. EOA mode (the funds ARE the EOA) is exempt.
    if (getSigType() === 3) {
      const code = await getPublicClient().getCode({ address: vault }).catch(() => undefined);
      if (!code || code === "0x") {
        return {
          text: `Your deposit wallet ${vault} is not deployed yet — deploy it FIRST with ` +
            `action:"setup" confirm:true (gasless, credentials bootstrapped automatically), then fund. ` +
            `Funding an undeployed vault strands your USDC at the bridge (it can't deliver pUSD to a vault that doesn't exist).`,
          isError: true,
        };
      }
    }

    // getChainBalance returns null specifically to distinguish "could not read"
    // from "holds nothing". Coercing that to 0 printed "holds $0.00 USDC — top up
    // first" as a statement of fact to a user holding $200, on nothing more than
    // an RPC blip, and sent them off to fund a wallet that was already funded.
    const baseBalanceRaw = await getChainBalance("base", agent);
    if (baseBalanceRaw === null) {
      return {
        text: `Could not read the USDC balance of your Base wallet ${agent} (RPC unavailable). ` +
          `Not funding blind — re-run in a moment. Your funds are untouched.`,
        isError: true,
      };
    }
    const baseBalance = baseBalanceRaw;
    const needed = amountUsd + FUND_FEE_USD;
    if (baseBalance < needed) {
      return {
        text: `Your Base wallet ${agent} holds $${baseBalance.toFixed(2)} USDC — need $${needed.toFixed(2)} ` +
          `($${amountUsd.toFixed(2)} deposit + $${FUND_FEE_USD} fee). Top up your Base USDC first.`,
        isError: true,
      };
    }

    const bridge = await bridgeAddressFor(vault);

    // An earlier funding call whose outcome is unknown: its authorization may
    // still be executed by the facilitator until its deadline, and a second
    // one signed on top of it double-sends the full amount. Refuse to sign
    // until the window has passed (the balance reads then show what
    // happened); the dry-run only warns. Mirrors withdraw's pendingWithdraw.
    const pending = loadState().pendingFund;
    const nowSec = Math.floor(Date.now() / 1000);
    const pendingWaitSecs = pending ? pending.deadline + FUND_GUARD_GRACE_SECS - nowSec : 0;
    if (pending && pendingWaitSecs <= 0) saveState({ pendingFund: undefined }); // expired — safe

    if (input.confirm !== true) {
      return {
        text: [
          `DRY RUN — nothing moved.`,
          `Fund your Polymarket vault with $${amountUsd.toFixed(2)} USDC (gasless):`,
          `  from Base wallet: ${agent}`,
          `  → bridge:         ${bridge}`,
          `  → wraps to pUSD in your vault: ${vault}`,
          `  fee: $${FUND_FEE_USD} (BlockRun pays the Base gas; you need no ETH)`,
          ...(pending && pendingWaitSecs > 0
            ? [
                ``,
                `⚠️ A previous funding call for $${pending.amountUsd.toFixed(2)} has an UNKNOWN outcome and its signed ` +
                  `authorization may still execute for ~${pendingWaitSecs}s. confirm:true is refused until then — ${FUND_GUIDANCE}.`,
              ]
            : []),
          ``,
          `Re-call with confirm:true to sign and submit.`,
        ].join("\n"),
        structured: { dryRun: true, amountUsd, agent, bridge, vault, feeUsd: FUND_FEE_USD, ...(pending && pendingWaitSecs > 0 ? { pendingFund: pending } : {}) },
      };
    }

    if (pending && pendingWaitSecs > 0) {
      return {
        text: `Refusing to sign: a previous funding call for $${pending.amountUsd.toFixed(2)} has an UNKNOWN outcome — ` +
          `its signed USDC authorization may still execute for up to ~${pendingWaitSecs}s more, and signing another ` +
          `now could double-send. Nothing was signed. Re-run after that window; meanwhile ${FUND_GUIDANCE}.`,
        isError: true,
        structured: { refused: "pending_fund", pendingFund: pending },
      };
    }

    // Reserve the gateway fee against the x402 budget BEFORE the dialog and
    // the signature, like every other paid tool: a cap the fee would cross
    // refuses here, with nothing signed. Released in the finally below —
    // recordActualSpend books the settled figure on the paths that paid.
    const feeGate = input.budget ? reserveBudget(input.budget, input.agent_id, FUND_FEE_USD) : null;
    if (feeGate && !feeGate.allowed) {
      return {
        text: `${feeGate.reason}. The $${FUND_FEE_USD} funding fee is BlockRun API spend and counts against the budget cap ` +
          `(blockrun_wallet action:"report" / action:"delegate"). Nothing was signed.`,
        isError: true,
      };
    }
    try {
      // The user's word before the signature, when the operator asked for it
      // (BLOCKRUN_CONFIRM_SPEND=on): the full amount plus the fee leaves the
      // Base wallet on this signature.
      if (input.askUser) {
        const gate = await input.askUser(amountUsd + FUND_FEE_USD, `polymarket · fund vault ${vault} from ${agent}`);
        if (!gate.ok) return declinedResult(`the $${amountUsd.toFixed(2)} funding authorization`);
      }

      // Sign the EIP-3009 deposit authorization: Base USDC → bridge address.
      const privateKey = getOrCreateWalletKey();
      const amountMicro = String(Math.floor(amountUsd * 10 ** USDC_DECIMALS));
      const deadline = Math.floor(Date.now() / 1000) + FUND_AUTH_VALIDITY_SECS;
      const depositAuthorization = await createPaymentPayload(
        privateKey, agent, bridge, amountMicro, `eip155:${BASE_CHAIN_ID}`,
        { maxTimeoutSeconds: FUND_AUTH_VALIDITY_SECS },
      );

      // Call the gateway fund endpoint — it charges $0.01 via x402 automatically
      // and relays the deposit authorization to the CDP facilitator (pays gas).
      // Arm the guard BEFORE the POST: a crash mid-request must leave it set.
      saveState({ pendingFund: { amountUsd, deadline } });
      const client = new BlockrunClient({ privateKey });
      let result: {
        success?: boolean;
        funded?: boolean;
        creditPending?: boolean;
        deposit?: { txHash?: string; amountUsd?: number };
        fee?: { txHash?: string };
        error?: string;
      };
      // What "failed" means depends on WHEN it failed. A definite 4xx (or a
      // refused fee payment) proves the authorization was never forwarded —
      // plain failure, guard cleared. Anything else — timeout, dropped socket,
      // 5xx, or a success:false body — arrives after the gateway may already
      // have handed the authorization to the facilitator, and the old bare
      // "Funding failed" invited the retry that signs a second $amount.
      const outcomeUnknown = (detail: string): ToolResult => ({
        text: `⚠️ Funding outcome UNKNOWN — the gateway did not confirm the $${amountUsd.toFixed(2)} deposit (${detail}). ` +
          `The signed USDC authorization MAY already have been forwarded and broadcast on Base. Do NOT retry yet: ` +
          `${FUND_GUIDANCE}. This tool refuses to re-sign for ~${FUND_AUTH_VALIDITY_SECS + FUND_GUARD_GRACE_SECS}s ` +
          `(the authorization's validity window) so a retry cannot double-send.`,
        isError: true,
        structured: { outcome: "unknown", amountUsd, agent, bridge, vault, pendingFund: { amountUsd, deadline } },
      });
      try {
        result = (await client.post("/v1/polymarket/fund", {
          depositWallet: vault,
          recipient: bridge,
          amountMicro,
          depositAuthorization,
        })) as typeof result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (isDefiniteFundRejection(err)) {
          saveState({ pendingFund: undefined });
          return { text: `Funding failed: ${msg}. The gateway rejected the request before forwarding it — nothing moved.`, isError: true };
        }
        // The fee payment left with the request; book the estimate rather than
        // under-count a charge that may have settled (the same trade-off the
        // other paid tools make on a lost response).
        if (input.budget) recordActualSpend(input.budget, null, FUND_FEE_USD, input.agent_id);
        return outcomeUnknown(msg);
      }

      // The SDK settles the 402 quote into its session spend on a 2xx — the fee
      // the gateway actually charged, whatever the route is priced at today.
      // getSpending throws in account mode, which cannot reach here (Polymarket
      // is wallet-only) — guarded anyway so a booking never masks a success.
      if (input.budget) {
        let observed: number | null = null;
        try { observed = client.getSpending().totalUsd; } catch { observed = null; }
        recordActualSpend(input.budget, observed && observed > 0 ? observed : null, FUND_FEE_USD, input.agent_id);
      }

      if (!result?.success) {
        return outcomeUnknown(`gateway said success:false — ${result?.error ?? JSON.stringify(result)}`);
      }
      saveState({ pendingFund: undefined });

      // success:true = the deposit was SUBMITTED to the bridge + fee charged on
      // Base. It does NOT mean the vault is funded: the Polymarket bridge credits
      // pUSD on Polygon asynchronously (usually minutes, occasionally 30+),
      // off-chain and un-pollable here — don't claim "Funded" (issue #226).
      return {
        text: [
          `✅ Deposit of $${amountUsd.toFixed(2)} USDC submitted to the Polymarket bridge (gasless).`,
          `  from Base wallet: ${agent}`,
          ...(result.deposit?.txHash ? [`  deposit tx: https://basescan.org/tx/${result.deposit.txHash}`] : []),
          `  ⏳ pUSD credit to your vault ${vault} is PENDING — the bridge settles on Polygon`,
          `     asynchronously (usually minutes, occasionally 30+). Re-run action:"setup"`,
          `     and watch for the pUSD balance; it is not instant.`,
          `  Fee charged: $${FUND_FEE_USD}.`,
        ].join("\n"),
        structured: {
          success: true,
          funded: false,
          creditPending: true,
          amountUsd,
          agent,
          bridge,
          vault,
          deposit: result.deposit,
          fee: result.fee,
        },
      };
    } finally {
      feeGate?.release();
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { text: `Funding error: ${msg}`, isError: true };
  }
}
