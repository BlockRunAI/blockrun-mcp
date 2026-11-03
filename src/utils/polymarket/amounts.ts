// src/utils/polymarket/amounts.ts
//
// Dollar amount -> integer micro-units, shared by withdraw (pUSD) and fund
// (Base USDC). Both tokens use 6 decimals.

const STABLECOIN_DECIMALS = 6;

/**
 * Parse a dollar amount into micro-units of a 6-decimal stablecoin (pUSD,
 * USDC) without silently changing what the caller asked for. The old
 * `Math.floor(usd * 1e6)` truncated float noise downward: `2.01 * 1e6` is
 * 2_009_999.9999999998, so "$2.01" signed $2.009999 (about 15% of all cent
 * amounts land just under the integer). Round to the nearest micro-dollar and
 * reject anything that isn't representable (over-precision, negatives, NaN).
 */
export function parseUsdAmount(amount: number): bigint | null {
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const scaled = amount * 10 ** STABLECOIN_DECIMALS;
  const rounded = Math.round(scaled);
  // 0.01 micro-dollars separates the two populations cleanly: float noise on a
  // representable amount is ≤ ~1e-4 micro even at $1M (ulp-scale), while a
  // genuine 7th-decimal digit is ≥ 0.1 micro. An absolute 1e-7 bound (the
  // first draft) sat BELOW the noise floor and rejected honest amounts like
  // $1234.56 (noise 2.4e-7); a relative bound sat above real violations.
  if (!Number.isSafeInteger(rounded) || rounded <= 0 || Math.abs(scaled - rounded) > 0.01) {
    return null;
  }
  return BigInt(rounded);
}
