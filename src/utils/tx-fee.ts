// src/utils/tx-fee.ts
//
// The gateway charges base + a flat transaction fee. Every budget estimate in
// this server must reserve the CHARGE, not the base — otherwise the gate
// under-reserves on every paid call and recordSpending() under-counts the ledger.
//
// WHY THIS EXISTS: a 402's JSON body reports `price: {amount}` = the BASE. What
// x402 actually charges is the `amount` inside the base64 `payment-required`
// RESPONSE HEADER, and it is base + $0.002. (This gateway speaks x402Version 2,
// whose field is `amount`. v1's `maxAmountRequired` is simply absent — read that
// key and you get `null` rather than an error, which reads as "free".) The two
// differ on every route:
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
//     | jq '.accepts[0].amount'   # micro-USDC; / 1e6 = USD
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
  // Never pass a non-number/non-finite value through. `!(x > 0)` is true for NaN,
  // for a function, and for a string — so the old early-return handed them
  // straight to the budget gate, where Math.max(0, x) becomes NaN, `cost > 0` is
  // false (so the call is ALLOWED), and `spent += NaN` disables every cap for the
  // life of the process. That actually happened: a prototype-chain hit on the
  // modal GPU table returned Object.prototype.toString. A bad estimate must fail
  // CLOSED — treat it as free-but-unpriceable rather than poison the ledger.
  if (typeof baseUsd !== "number" || !Number.isFinite(baseUsd)) return 0;
  if (!(baseUsd > 0)) return baseUsd;
  // CEIL, mirroring the gateway's usdToMicroUsdc: `Math.ceil(usd * 1_000_000)`.
  // Rounding is correct only by luck — it agrees with ceil whenever the addition
  // is exact, and silently under-reserves by one micro-dollar wherever float
  // drift creeps in, which is precisely where a x1.05 margin is involved:
  //
  //   base            base + fee              *1e6                ceil    round
  //   0.005           0.007                   7000                7000    7000   (agree)
  //   0.0075          0.0095                  9500                9500    9500   (agree)
  //   0.05 * 1.05     0.05450000000000001     54500.00000000001   54501   54500  <- round is SHORT
  //   0.015 * 1.05    0.017750000000000002    17750.000000000004  17751   17750  <- round is SHORT
  //
  // The server ceils unconditionally, so we must too. Verified live:
  // audio/sound-effects quotes 54501 micro, not 54500.
  return Math.ceil((baseUsd + TRANSACTION_FEE_USD) * 1e6) / 1e6;
}
