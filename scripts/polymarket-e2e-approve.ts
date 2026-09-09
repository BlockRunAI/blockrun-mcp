/**
 * One-time preflight for the bounded live redeem test: signs the approval
 * batch (including the two collateral-adapter operators redeem requires),
 * then re-reads the resulting on-chain state. Prints no wallet address or
 * transaction id. From @KillerQueen-Z's #66.
 */
import { runSetup } from "../src/utils/polymarket/setup.js";
import { failRedacted } from "./redact.js";

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
