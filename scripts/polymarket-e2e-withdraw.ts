/** Bounded live withdrawal check, independent of the adapter-approval flow. */
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
