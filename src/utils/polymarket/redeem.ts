// src/utils/polymarket/redeem.ts
//
// Claim winnings for a resolved market. Burns the ERC-1155 outcome tokens and
// credits collateral back to the funds wallet:
//   - POLY_1271: a gasless relayer WALLET batch executed BY the deposit wallet
//     (redeemPositions credits msg.sender, i.e. the deposit wallet).
//   - EOA mode: a direct transaction from the EOA (needs POL gas).
//
// Target contracts: CTF positions remain backed by legacy USDC.e / NegRisk
// wrapped collateral, while user balances are pUSD. The V2 collateral adapters
// are therefore the only valid public redeem entrypoints: they pull and redeem
// the real ERC-1155 positions, then wrap the resulting USDC.e into pUSD.
import { createWalletClient, encodeFunctionData, http, type Hex } from "viem";
import { polygon } from "viem/chains";
import { getPolymarketAccount } from "./client.js";
import {
  CTF_COLLATERAL_ADAPTER,
  CONDITIONAL_TOKENS,
  ERC1155_ABI,
  getSigType,
  NEG_RISK_CTF_COLLATERAL_ADAPTER,
  POLYGON_WRITE_RPC_URL,
  PUSD_DECIMALS,
} from "./constants.js";
import type { ToolResult } from "./orders.js";
import { mapClobError } from "./orders.js";
import { fetchPositions, getFundsAddress, type DataApiPosition } from "./positions.js";
import { sendWalletBatch } from "./relayer.js";
import { getPublicClient, getPusdBalance } from "./setup.js";
import { assertTransactionSucceeded } from "./transactions.js";

export function heldOutcomeTokens(positions: DataApiPosition[], conditionId: string): DataApiPosition[] {
  return positions.filter((position) =>
    position.conditionId?.toLowerCase() === conditionId.toLowerCase() && Boolean(position.asset),
  );
}

/**
 * Both official V2 collateral adapters intentionally retain the CTF
 * redeemPositions ABI. The collateral/parent/index-set values are ignored by
 * the adapter; it derives the real legacy position IDs from conditionId.
 */
export function buildRedeemCall(negRisk: boolean, conditionId: Hex): { target: Hex; data: Hex } {
  return {
    target: (negRisk ? NEG_RISK_CTF_COLLATERAL_ADAPTER : CTF_COLLATERAL_ADAPTER) as Hex,
    data: encodeFunctionData({
      abi: ERC1155_ABI,
      functionName: "redeemPositions",
      args: [
        "0x0000000000000000000000000000000000000000",
        "0x0000000000000000000000000000000000000000000000000000000000000000",
        conditionId,
        [],
      ],
    }),
  };
}

/** A receipt alone is insufficient: a wrong collateral path can be a no-op. */
export function didRedeemAnyHeldPosition(before: readonly bigint[], after: readonly bigint[]): boolean {
  return before.some((balance, index) => balance > 0n && (after[index] ?? balance) < balance);
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
    // Redeem only needs the caller's held token IDs and neg-risk flag. The
    // Data API supplies both; CLOB market lookup is deliberately avoided here
    // because some supported egress routes return 404 for market metadata.
    const heldPositions = heldOutcomeTokens(await fetchPositions(owner), conditionId);
    if (!heldPositions.length) {
      return {
        text: `Could not find held outcome tokens for condition ${conditionId}. ` +
          `Re-run action:"positions" and pass a condition_id that belongs to this wallet.`,
        isError: true,
      };
    }
    const tokens = heldPositions.map((position) => ({
      token_id: position.asset!, outcome: position.outcome, winner: position.redeemable,
    }));
    const question = heldPositions[0]?.title;

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
      return { text: `Nothing to redeem: ${owner} holds no outcome tokens for "${question ?? conditionId}".`, isError: true };
    }

    const negRisk = heldPositions.some((position) => position.negativeRisk === true);
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
          `Market: ${question ?? conditionId}`,
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

    let txHash: string | undefined;
    if (getSigType() === 3) {
      const res = await sendWalletBatch([{ target, value: "0", data }], owner, "Redeem");
      txHash = res.transactionHash;
    } else {
      const account = getPolymarketAccount();
      const wallet = createWalletClient({ account, chain: polygon, transport: http(POLYGON_WRITE_RPC_URL) });
      txHash = await wallet.sendTransaction({ to: target, data, chain: polygon, account });
      assertTransactionSucceeded(await pc.waitForTransactionReceipt({ hash: txHash as Hex }), "Redeem transaction");
    }

    // A receipt can arrive before every public RPC reflects its state. Retry
    // the read briefly before treating this as an indeterminate verification.
    let balanceAfter = await getPusdBalance(owner).catch(() => null);
    let balancesAfter: bigint[] | null = null;
    for (let attempt = 0; attempt < 3 && balancesAfter === null; attempt++) {
      balancesAfter = await Promise.all(tokens.map((t) => pc.readContract({
        address: CONDITIONAL_TOKENS as Hex,
        abi: ERC1155_ABI,
        functionName: "balanceOf",
        args: [owner, BigInt(t.token_id as string)],
      }))).catch(() => null);
      if (balancesAfter === null && attempt < 2) await new Promise((resolve) => setTimeout(resolve, 750));
    }
    if (balanceAfter === null) balanceAfter = await getPusdBalance(owner).catch(() => null);
    if (balancesAfter === null) {
      return {
        text: [
          `⚠️ Redeem transaction confirmed, but its token effect could not be verified because the Polygon RPC read failed.`,
          `Do not retry blindly; inspect the transaction and re-run action:"positions" after the RPC recovers.`,
          ...(txHash ? [`  tx: https://polygonscan.com/tx/${txHash}`] : []),
        ].join("\n"),
        structured: { status: "confirmed_but_unverified", conditionId, negRisk, transactionHash: txHash, pusdBalance: balanceAfter },
        isError: true,
      };
    }
    if (!didRedeemAnyHeldPosition(balances, balancesAfter)) {
      return {
        text: [
          `⚠️ Redeem transaction confirmed, but held ERC-1155 outcome tokens did not decrease.`,
          `No payout is being reported. Re-run action:"positions"; this indicates an unexpected collateral route or stale chain state.`,
          ...(txHash ? [`  tx: https://polygonscan.com/tx/${txHash}`] : []),
        ].join("\n"),
        structured: { status: "no_effect_detected", conditionId, negRisk, transactionHash: txHash, pusdBalance: balanceAfter },
        isError: true,
      };
    }
    return {
      text: [
        `✅ Redeemed "${question ?? conditionId}".`,
        heldText,
        ...(txHash ? [`  tx: https://polygonscan.com/tx/${txHash}`] : []),
        ...(balanceAfter !== null ? [`  Funds wallet pUSD balance: $${balanceAfter.toFixed(2)}`] : []),
      ].join("\n"),
      structured: { conditionId, negRisk, transactionHash: txHash, pusdBalance: balanceAfter },
    };
  } catch (err) {
    const base = await mapClobError(err);
    return { text: base, isError: true };
  }
}
