// src/utils/settled-error.ts
//
// A leaf module (no imports): raw-call.ts and api-key-call.ts both throw this
// and raw-call imports api-key-call, so the class lives below both.

/**
 * The call SETTLED and then failed to hand back a usable body. On the wallet
 * rails the SDK counts the settlement on the paid retry's 2xx and only then
 * reads the body (SolanaLLMClient.requestWithPaymentRaw: assertPaid →
 * recordSettlement → json()), so a non-JSON 200 surfaces as a bare
 * SyntaxError — no status, no transport words, "none" to settlementOnThrow —
 * for a call that was paid; the SDK's counter delta is the evidence and rides
 * here as `settledUsd`. On the account rail a 2xx carries `x-blockrun-cost-usd`
 * and the same unreadable body used to be returned as a successful `{}`
 * (round 4b); the header's figure rides here instead, or null when the
 * response carried none — the tool then books its reserve.
 */
export class RawCallSettledError extends Error {
  readonly settledUsd: number | null;
  constructor(message: string, settledUsd: number | null, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RawCallSettledError";
    this.settledUsd = settledUsd;
  }
}
