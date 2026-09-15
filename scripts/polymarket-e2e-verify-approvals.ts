/**
 * Read-only: report the on-chain approval state for the local wallet. Never
 * supplies confirm:true. Prints no wallet address on any exit path — the
 * on-chain reads go through a Polygon RPC, and a viem error interpolates the
 * owner address into its message, so the redacted exit is installed first.
 */
import { runSetup } from "../src/utils/polymarket/setup.js";
import { installRedactedExit } from "./redact.js";

installRedactedExit();

const result = await runSetup({ confirm: false });
const approvals = result.structured.approvals as Array<{ label: string; granted: boolean }>;
console.log(JSON.stringify({
  adaptersApproved: approvals.filter(({ label }) => label.includes("Collateral Adapter")),
  approvalsPending: result.structured.approvalsPending,
}, null, 2));
