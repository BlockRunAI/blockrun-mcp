/**
 * Bounded live withdrawal check ($2 cap), independent of the approval flow.
 * Wallet addresses and transaction ids are never printed, on any exit path.
 * From #66.
 */
import { withdrawFunds } from "../src/utils/polymarket/withdraw.js";
import { failRedacted, redactChainValues } from "./redact.js";

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
