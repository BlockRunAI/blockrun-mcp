/**
 * A deliberately narrow live verification for the redeem/withdraw repair.
 * Preconditions prevent it from redeeming a valuable position or moving more
 * than $2.00. Wallet addresses and transaction IDs are never printed.
 */
import { fetchPositions, getFundsAddress } from "../src/utils/polymarket/positions.js";
import { redeemPosition } from "../src/utils/polymarket/redeem.js";
import { withdrawFunds } from "../src/utils/polymarket/withdraw.js";

const owner = getFundsAddress();
const positions = await fetchPositions(owner);
const target = positions.find((position) =>
  position.redeemable === true &&
  (position.currentValue ?? Number.POSITIVE_INFINITY) <= 0.001 &&
  Boolean(position.conditionId),
);

if (!target?.conditionId) {
  throw new Error("No zero-value redeemable position is available for the bounded live redeem test.");
}

const redeem = await redeemPosition({ condition_id: target.conditionId, confirm: true });
if (redeem.isError || redeem.structured?.status !== undefined) {
  throw new Error(`Redeem verification did not complete cleanly: ${redeem.text.replace(/0x[a-fA-F0-9]{64}/g, "<tx>")}`);
}

const withdrawal = await withdrawFunds({ amount_usd: 2, confirm: true });
if (withdrawal.isError) {
  throw new Error(`Withdrawal submission failed: ${withdrawal.text.replace(/0x[a-fA-F0-9]{64}/g, "<tx>")}`);
}

console.log(JSON.stringify({
  redeem: {
    verified: true,
    market: target.title,
    outcome: target.outcome,
    sharesBurned: target.size,
  },
  withdrawal: {
    submitted: true,
    amountUsd: 2,
    destinationChainId: withdrawal.structured?.toChainId,
  },
}, null, 2));
