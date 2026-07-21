import { runSetup } from "../src/utils/polymarket/setup.js";

const result = await runSetup({ confirm: false });
const approvals = result.structured.approvals as Array<{ label: string; granted: boolean }>;
console.log(JSON.stringify({
  adaptersApproved: approvals.filter(({ label }) => label.includes("Collateral Adapter")),
  approvalsPending: result.structured.approvalsPending,
}, null, 2));
