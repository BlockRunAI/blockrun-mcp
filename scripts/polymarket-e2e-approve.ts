/**
 * One-time preflight for the bounded live redeem test: signs the approval
 * batch (including the two collateral-adapter operators redeem requires),
 * then re-reads the resulting on-chain state. Prints no wallet address or
 * transaction id. From @KillerQueen-Z's #66.
 *
 * Signs on-chain approvals with the real wallet, so it refuses to run without
 * --confirm (or POLYMARKET_E2E_CONFIRM=1) — see ./e2e-confirm.ts.
 */
import { runSetup } from "../src/utils/polymarket/setup.js";
import { requireLiveConfirm } from "./e2e-confirm.js";
import { failRedacted, installRedactedExit } from "./redact.js";

installRedactedExit();
requireLiveConfirm([
  "sign and submit the Polymarket operator approval batch (unlimited allowances unless POLYMARKET_BOUNDED_APPROVALS is set) from the funded wallet",
]);

try {
  const submitted = await runSetup({ confirm: true });
  const verified = await runSetup({ confirm: false });
  const approvals = verified.structured.approvals as Array<{ label: string; granted: boolean }>;
  console.log(JSON.stringify({
    approvalBatchSubmitted: !submitted.structured.approvalsPending,
    adaptersApproved: approvals.filter(({ label }) => label.includes("Collateral Adapter")),
    approvalsPending: verified.structured.approvalsPending,
  }, null, 2));
} catch (error) {
  failRedacted("", error);
}
