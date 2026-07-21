/**
 * One-time preflight for the bounded live redeem test. It grants only the two
 * official collateral adapters the ERC-1155 operator permissions that their
 * redeem entrypoints require, then re-reads the resulting state. It prints no
 * wallet address or transaction id.
 */
import { runSetup } from "../src/utils/polymarket/setup.js";

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
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ failed: true, error: message.replace(/0x[a-fA-F0-9]{40,}/g, "<redacted>") }));
  process.exitCode = 1;
}
