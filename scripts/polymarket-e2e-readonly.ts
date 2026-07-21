/**
 * Read-only local-wallet preflight for Polymarket redeem/withdraw changes.
 * It never supplies confirm:true and never emits a wallet address, private key,
 * or transaction identifier.
 */
import { listPositions } from "../src/utils/polymarket/positions.js";
import { withdrawFunds } from "../src/utils/polymarket/withdraw.js";

const [positionsResult, withdrawalResult] = await Promise.all([
  listPositions(),
  withdrawFunds({}),
]);

const positions = ((positionsResult.structured as {
  positions?: Array<{
    title?: string;
    outcome?: string;
    size?: number;
    currentValue?: number;
    redeemable?: boolean;
    negativeRisk?: boolean;
    conditionId?: string;
  }>;
} | undefined)?.positions ?? []).map((position) => ({
  title: position.title,
  outcome: position.outcome,
  size: position.size,
  currentValue: position.currentValue,
  redeemable: position.redeemable,
  negativeRisk: position.negativeRisk,
  condition: position.conditionId ? `${position.conditionId.slice(0, 10)}…` : undefined,
}));

console.log(JSON.stringify({
  positions,
  withdrawalPreview: withdrawalResult.isError
    ? withdrawalResult.text.replace(/0x[a-fA-F0-9]{40}/g, "<wallet>")
    : {
      dryRun: withdrawalResult.structured?.dryRun,
      amountUsd: withdrawalResult.structured?.amountUsd,
      pusdUsd: withdrawalResult.structured?.pusdUsd,
      usdceUsd: withdrawalResult.structured?.usdceUsd,
      wrapUsd: withdrawalResult.structured?.wrapUsd,
      toChainId: withdrawalResult.structured?.toChainId,
    },
}, null, 2));
