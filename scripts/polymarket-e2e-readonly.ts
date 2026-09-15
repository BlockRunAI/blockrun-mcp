/**
 * Read-only local-wallet preflight for Polymarket redeem/withdraw changes.
 * Never supplies confirm:true; never emits a wallet address, private key, or
 * transaction identifier — on any exit path, a thrown RPC error included
 * (installRedactedExit below; the header promise used to hold only for the
 * isError branch).
 *
 * An error is reported AS an error. listPositions() catches every failure
 * and returns `{ text, isError: true }` with no `structured`, and this script
 * used to read `structured?.positions ?? []` and print `positions: []` under
 * a success-shaped JSON — so a Data-API outage looked like an empty wallet,
 * and an operator concluded there was nothing to redeem. Now either side
 * failing prints the redacted message in its place and exits 1.
 * From @KillerQueen-Z's #66.
 */
import { listPositions } from "../src/utils/polymarket/positions.js";
import { withdrawFunds } from "../src/utils/polymarket/withdraw.js";
import { installRedactedExit, redactChainValues } from "./redact.js";

installRedactedExit();

const [positionsResult, withdrawalResult] = await Promise.all([
  listPositions(),
  withdrawFunds({}),
]);

const positions = positionsResult.isError ? { error: redactChainValues(positionsResult.text) } : ((positionsResult.structured as {
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

const failed = Boolean(positionsResult.isError || withdrawalResult.isError);
console.log(JSON.stringify({
  ok: !failed,
  positions,
  withdrawalPreview: withdrawalResult.isError
    ? redactChainValues(withdrawalResult.text)
    : {
      dryRun: withdrawalResult.structured?.dryRun,
      amountUsd: withdrawalResult.structured?.amountUsd,
      pusdUsd: withdrawalResult.structured?.pusdUsd,
      usdceUsd: withdrawalResult.structured?.usdceUsd,
      wrapUsd: withdrawalResult.structured?.wrapUsd,
      toChainId: withdrawalResult.structured?.toChainId,
    },
}, null, 2));
if (failed) process.exit(1);
