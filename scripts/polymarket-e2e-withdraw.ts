/**
 * Bounded live withdrawal check ($2 cap), independent of the approval flow.
 * Wallet addresses and transaction ids are never printed, on any exit path.
 * From #66.
 *
 * Moves real funds, so it refuses to run without --confirm (or
 * POLYMARKET_E2E_CONFIRM=1) — see ./e2e-confirm.ts.
 */
import { withdrawFunds } from "../src/utils/polymarket/withdraw.js";
import { requireLiveConfirm } from "./e2e-confirm.js";
import { failRedacted, installRedactedExit, redactChainValues } from "./redact.js";

installRedactedExit();
requireLiveConfirm(["withdraw $2.00 USDC from the Polymarket deposit wallet through the bridge"]);

const result = await withdrawFunds({ amount_usd: 2, confirm: true }).catch((error) =>
  failRedacted("Withdrawal submission threw: ", error),
);
if (result.isError) {
  failRedacted("", redactChainValues(result.text));
}
console.log(JSON.stringify({
  submitted: true,
  amountUsd: result.structured?.amountUsd,
  destinationChainId: result.structured?.toChainId,
}, null, 2));
