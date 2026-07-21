/** Bounded live withdrawal check ($2 cap), independent of the approval flow. From #66. */
import { withdrawFunds } from "../src/utils/polymarket/withdraw.js";

const result = await withdrawFunds({ amount_usd: 2, confirm: true });
if (result.isError) {
  throw new Error(result.text.replace(/0x[a-fA-F0-9]{64}/g, "<tx>"));
}
console.log(JSON.stringify({
  submitted: true,
  amountUsd: result.structured?.amountUsd,
  destinationChainId: result.structured?.toChainId,
}, null, 2));
