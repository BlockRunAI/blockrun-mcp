/**
 * One redaction for every live Polymarket e2e script.
 *
 * These scripts run against a real funded wallet and their output goes into
 * terminals, CI logs and issue comments. Three of them promised in their own
 * doc comment that "wallet addresses and transaction IDs are never printed",
 * and each implemented a different regex: `{64}` (transaction hashes only, so
 * a 40-hex ADDRESS printed in full), `{40}` (addresses only), and `{40,}`
 * (both, but labelled `<redacted>` either way). The first is the one that
 * broke the promise, and withdraw.ts really does interpolate a bridge response
 * carrying an address into its error text.
 *
 * Longest-match-first in a single pass, so there is no ordering trap: a
 * transaction hash cannot be half-eaten by the address rule. A private key is
 * also 32 bytes and comes out as `<tx>` — mislabelled but redacted, which is
 * the direction that matters.
 */
export function redactChainValues(text: string): string {
  return text.replace(/0x[a-fA-F0-9]{40,}/g, (match) => {
    if (match.length === 66) return "<tx>";
    if (match.length === 42) return "<wallet>";
    return "<redacted>";
  });
}

/**
 * Redact whatever a script is about to die with.
 *
 * The `isError` branch of a tool result was the only path any of these guarded.
 * A thrown exception — a network failure inside fetchPositions(), a viem revert
 * — bypassed it entirely and Node printed the raw message and stack. Install
 * this and every exit path is covered.
 */
export function failRedacted(prefix: string, error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ failed: true, error: redactChainValues(`${prefix}${message}`) }));
  process.exit(1);
}
