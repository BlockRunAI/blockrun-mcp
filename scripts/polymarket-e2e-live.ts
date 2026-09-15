/**
 * A deliberately narrow live verification of redeem + withdraw. Preconditions
 * prevent it from redeeming a valuable position (≤ $0.001 current value) or
 * moving more than $2.00. Wallet addresses and transaction IDs are never
 * printed. From @KillerQueen-Z's #66; success check updated for the tri-state
 * redeem statuses main ships (only status:"redeemed" counts).
 *
 * The redaction covers every exit path, thrown errors included — see
 * ./redact.ts for why that is not the same regex it used to be.
 *
 * Moves real funds, so it refuses to run without --confirm (or
 * POLYMARKET_E2E_CONFIRM=1) — see ./e2e-confirm.ts. `npm run
 * e2e:polymarket:live -- --confirm`.
 */
import { fetchPositions, getFundsAddress } from "../src/utils/polymarket/positions.js";
import { redeemPosition } from "../src/utils/polymarket/redeem.js";
import { withdrawFunds } from "../src/utils/polymarket/withdraw.js";
import { requireLiveConfirm } from "./e2e-confirm.js";
import { failRedacted, installRedactedExit, redactChainValues } from "./redact.js";

installRedactedExit();
// Gate first: a check that runs after the redeem is a receipt.
requireLiveConfirm([
  "redeem one resolved position worth <= $0.001 (burns the shares)",
  "withdraw $2.00 USDC from the Polymarket deposit wallet through the bridge",
]);

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
if (redeem.isError || redeem.structured?.status !== "redeemed") {
  failRedacted("Redeem verification did not complete cleanly: ", redactChainValues(redeem.text));
}

const withdrawal = await withdrawFunds({ amount_usd: 2, confirm: true });
if (withdrawal.isError) {
  failRedacted("Withdrawal submission failed: ", redactChainValues(withdrawal.text));
}

console.log(JSON.stringify({
  redeem: { verified: true, market: target.title, outcome: target.outcome, sharesBurned: target.size },
  withdrawal: { submitted: true, amountUsd: 2, destinationChainId: withdrawal.structured?.toChainId },
}, null, 2));
