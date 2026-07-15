// src/utils/tx-fee.ts
//
// The gateway charges base + a flat transaction fee. Every budget estimate in
// this server must reserve the CHARGE, not the base — otherwise the gate
// under-reserves on every paid call and recordSpending() under-counts the ledger.
//
// WHY THIS EXISTS: a 402's JSON body reports `price: {amount}` = the BASE. What
// x402 actually charges is `maxAmountRequired` inside the base64
// `payment-required` RESPONSE HEADER, and it is base + $0.002. The two differ on
// every route:
//
//   route                     body      charged
//   pm/polymarket/markets     $0.0075   $0.0095
//   surf/market/price         $0.0075   $0.0095
//   defillama/protocols       $0.0050   $0.0070
//   exa/search                $0.0100   $0.0120
//   search (max_results=10)   $0.2625   $0.2645
//
// Reading the body is a trap this codebase has fallen into three times: stale
// tiers after the gateway went flat, then the base mistaken for the price, then
// every remaining tool left on the base while three were fixed by hand. Probe it
// for free — send any request with no payment header and decode the header:
//
//   curl -s -D - -o /dev/null https://blockrun.ai/api/v1/pm/polymarket/markets \
//     | grep -i '^payment-required:' | sed 's/^[^:]*: *//' | base64 -d \
//     | jq '.accepts[0].maxAmountRequired'   # micro-USDC; / 1e6 = USD
//
// Mirrors addTransactionFee() in the gateway's src/lib/models.ts. Keep in step.

/**
 * Flat per-transaction fee the gateway adds on top of every non-zero price.
 * Mirrors TRANSACTION_FEE_USD in the gateway (raised 0.001 -> 0.002 on
 * 2026-07-11 to cover on-chain gas). Env-overridable there, so if it moves the
 * estimates here go short until this constant follows.
 */
export const TRANSACTION_FEE_USD = 0.002;

/**
 * Convert a BASE price into what the caller is actually charged.
 *
 * No-op for $0 so genuinely free paths stay free — mirrors the gateway's
 * `usd > 0 ? usd + TRANSACTION_FEE_USD : usd`. Without that guard, free tiers
 * (mode:"free", nvidia/*, free phone reads) would start reserving $0.002 and a
 * $0 budget would reject them.
 */
export function withTxFee(baseUsd: number): number {
  if (!(baseUsd > 0)) return baseUsd;
  // Integer micro-dollars: the float form drifts (0.005 + 0.002 is
  // 0.007000000000000001), and a reserve that reads as 0.0070000000000001 is
  // cosmetically wrong in every budget message it appears in.
  return Math.round((baseUsd + TRANSACTION_FEE_USD) * 1e6) / 1e6;
}
