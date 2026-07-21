// src/utils/polymarket/redeem.ts
//
// Claim winnings for a resolved market. Burns the ERC-1155 outcome tokens and
// credits pUSD back to the funds wallet:
//   - POLY_1271: a gasless relayer WALLET batch executed BY the deposit wallet
//     (the adapter credits msg.sender, i.e. the deposit wallet).
//   - EOA mode: a direct transaction from the EOA (needs POL gas).
//
// Target contracts — ALWAYS the pUSD collateral adapters, NEVER the CTF or the
// legacy NegRiskAdapter directly. CTF positions (the CLOB token_ids) are still
// keyed to USDC.e (standard) / the legacy adapter's wrapped collateral
// (neg-risk); a direct CTF redeem with pUSD collateral computes a positionId
// nobody holds and SUCCEEDS redeeming 0 — success + tx hash, zero payout (the
// bug behind data-api "REDEEM size=0" reports). The adapters pull the caller's
// outcome tokens (one-time CTF operator approval, granted in setup), redeem
// through the right underlying path, wrap the USDC.e payout into pUSD, and
// return pUSD to the caller:
//   - standard binary markets → CtfCollateralAdapter.redeemPositions(...)
//   - negRisk markets → NegRiskCtfCollateralAdapter.redeemPositions(...)
// Both mirror the CTF redeemPositions(collateral, parent, conditionId,
// indexSets) signature; only conditionId is read — the adapter derives the
// position ids and amounts (full caller balance) itself.
import { createWalletClient, encodeFunctionData, http, type Hex } from "viem";
import { polygon } from "viem/chains";
import { getClobClient, getPolymarketAccount } from "./client.js";
import {
  CONDITIONAL_TOKENS,
  CTF_COLLATERAL_ADAPTER,
  ERC1155_ABI,
  getSigType,
  NEG_RISK_CTF_COLLATERAL_ADAPTER,
  POLYGON_WRITE_RPC_URL,
  PUSD_COLLATERAL,
  PUSD_DECIMALS,
} from "./constants.js";
import type { ToolResult } from "./orders.js";
import { mapClobError } from "./orders.js";
import { getFundsAddress } from "./positions.js";
import { sendWalletBatch } from "./relayer.js";
import { getPublicClient, getPusdBalance } from "./setup.js";

interface ClobMarketToken { token_id?: string; outcome?: string; winner?: boolean }

/**
 * Redeem call for the pUSD collateral adapter (standard or neg-risk). Exported
 * for unit tests — the target/calldata pair is the money-critical part of this
 * file. The CTF-mirror arguments besides conditionId are ignored by the
 * adapter; we pass the canonical values anyway so the calldata reads sanely on
 * a block explorer.
 */
export function buildRedeemCall(negRisk: boolean, conditionId: Hex): { target: Hex; data: Hex } {
  return {
    target: (negRisk ? NEG_RISK_CTF_COLLATERAL_ADAPTER : CTF_COLLATERAL_ADAPTER) as Hex,
    data: encodeFunctionData({
      abi: ERC1155_ABI,
      functionName: "redeemPositions",
      args: [PUSD_COLLATERAL as Hex, "0x0000000000000000000000000000000000000000000000000000000000000000", conditionId, [1n, 2n]],
    }),
  };
}

export async function redeemPosition(input: { condition_id?: string; confirm?: boolean }): Promise<ToolResult> {
  if (!input.condition_id) {
    return { text: `Pass condition_id:"0x…" (see action:"positions" for redeemable markets).`, isError: true };
  }
  const conditionId = input.condition_id as Hex;

  let owner: Hex;
  try {
    owner = getFundsAddress();
  } catch (err) {
    return { text: err instanceof Error ? err.message : String(err), isError: true };
  }

  try {
    // Market metadata (question, outcome tokens, negRisk) via the CLOB.
    const clob = await getClobClient();
    const market = (await clob.getMarket(conditionId)) as {
      question?: string;
      neg_risk?: boolean;
      closed?: boolean;
      tokens?: ClobMarketToken[];
    };
    const tokens = (market?.tokens ?? []).filter((t) => t.token_id);
    if (!tokens.length) return { text: `No tokens found for condition ${conditionId}.`, isError: true };

    // Exact on-chain balances per outcome token — the redeem amounts.
    const pc = getPublicClient();
    const balances: bigint[] = [];
    for (const t of tokens) {
      balances.push(
        await pc.readContract({
          address: CONDITIONAL_TOKENS as Hex,
          abi: ERC1155_ABI,
          functionName: "balanceOf",
          args: [owner, BigInt(t.token_id as string)],
        }),
      );
    }
    if (balances.every((b) => b === 0n)) {
      return { text: `Nothing to redeem: ${owner} holds no outcome tokens for "${market?.question ?? conditionId}".`, isError: true };
    }

    const negRisk = Boolean(market?.neg_risk);
    const held = tokens
      .map((t, i) => ({ outcome: t.outcome, winner: t.winner, shares: Number(balances[i]) / 10 ** PUSD_DECIMALS }))
      .filter((h) => h.shares > 0);
    const heldText = held
      .map((h) => `  ${h.shares.toFixed(2)} × "${h.outcome}"${h.winner ? " (winner → pays $1/share)" : ""}`)
      .join("\n");

    if (input.confirm !== true) {
      return {
        text: [
          `DRY RUN — nothing redeemed.`,
          `Market: ${market?.question ?? conditionId}${market?.closed === false ? " ⚠️ (not closed yet — redeem will revert until resolution)" : ""}`,
          `Holdings:`,
          heldText,
          ``,
          `Re-call with confirm:true to redeem the FULL balance (Polymarket redeems`,
          `everything for the condition; partial redemption is not supported).`,
        ].join("\n"),
        structured: { dryRun: true, conditionId, negRisk, holdings: held },
      };
    }

    const { target, data } = buildRedeemCall(negRisk, conditionId);

    // Balance BEFORE the tx so the success message can report the actual
    // payout delta — "tx succeeded" alone is NOT proof anything was paid
    // (that deception is the exact bug class this path was rewritten to fix).
    const balanceBefore = await getPusdBalance(owner).catch(() => null);

    let txHash: string | undefined;
    if (getSigType() === 3) {
      const res = await sendWalletBatch([{ target, value: "0", data }], owner, "Redeem");
      txHash = res.transactionHash;
    } else {
      const account = getPolymarketAccount();
      const wallet = createWalletClient({ account, chain: polygon, transport: http(POLYGON_WRITE_RPC_URL) });
      txHash = await wallet.sendTransaction({ to: target, data, chain: polygon, account });
      const receipt = await pc.waitForTransactionReceipt({ hash: txHash as Hex });
      if (receipt.status !== "success") {
        throw new Error(`execution reverted: redeem transaction ${txHash} reverted on-chain`);
      }
    }

    const balanceAfter = await getPusdBalance(owner).catch(() => null);
    const paidOut = balanceBefore !== null && balanceAfter !== null ? balanceAfter - balanceBefore : null;
    const heldWinner = held.some((h) => h.winner);
    if (paidOut !== null && paidOut <= 0 && heldWinner) {
      return {
        text: [
          `⚠️ Redeem transaction succeeded but paid out $0 while winning tokens were held.`,
          `This should not happen — the market may be routed to the wrong adapter or not fully`,
          `resolved on-chain yet. Your outcome tokens are NOT lost; re-run action:"positions"`,
          `to check, wait a few minutes, then retry. If it persists, report it.`,
          ...(txHash ? [`  tx: https://polygonscan.com/tx/${txHash}`] : []),
        ].join("\n"),
        structured: { conditionId, negRisk, transactionHash: txHash, paidOutUsd: 0, pusdBalance: balanceAfter },
        isError: true,
      };
    }
    return {
      text: [
        `✅ Redeemed "${market?.question ?? conditionId}".`,
        heldText,
        // paidOut === null means a balance read failed, which ALSO makes the
        // "paid $0 while holding a winner" guard above unreachable. Silently
        // omitting the payout line then rendered identically to a verified
        // payout — the exact size=0 silent-loss shape this module was rewritten
        // to kill. Say which one it is.
        ...(paidOut !== null
          ? [`  Paid out: $${paidOut.toFixed(2)} pUSD`]
          : [`  ⚠️ Payout UNVERIFIED — the pUSD balance read failed, so this is "the tx landed", not "you were paid". Re-run action:"positions" to confirm.`]),
        ...(txHash ? [`  tx: https://polygonscan.com/tx/${txHash}`] : []),
        ...(balanceAfter !== null ? [`  Funds wallet pUSD balance: $${balanceAfter.toFixed(2)}`] : []),
      ].join("\n"),
      structured: { conditionId, negRisk, transactionHash: txHash, paidOutUsd: paidOut, pusdBalance: balanceAfter, payoutVerified: paidOut !== null },
    };
  } catch (err) {
    const base = await mapClobError(err);
    // The adapter pulls tokens via safeBatchTransferFrom — a vault set up
    // before the collateral-adapter approvals were added reverts here.
    const approvalHint = ` If the transaction reverted, the wallet may be missing the collateral-adapter ` +
      `approval (added 2026-07) — run action:"setup" confirm:true once to grant it, then retry.`;
    return { text: `${base}${/revert|execution reverted|failed/i.test(base) ? approvalHint : ""}`, isError: true };
  }
}
