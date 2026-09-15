// src/utils/uncharged.ts
//
// A leaf module on purpose: no imports. errors.ts re-exports this, but
// errors.ts imports wallet.js and auth.js, and every handler suite that mocks
// utils/auth.js lists its named exports by hand — so a module that only needs
// this one predicate (in-flight.ts) imports it from here and stays linkable
// under those mocks.

/**
 * Every way this repo and the gateway say "the money did not move". The list
 * is longer than it looks because the sentence is written in five places by
 * four authors: the gateway ("payment NOT charged"), the SDK, the manual-402
 * tools ("No payment taken", "no charge was made"), and the quote guard
 * ("Refusing to sign it — no charge was made"). Exported because the path
 * tools' catch (utils/path-tool-catch.ts) and the in-flight tracker
 * (utils/in-flight.ts) must refuse to BOOK a charge the gateway says it never
 * took, using the same evidence formatError uses to refuse to SAY it.
 */
export function isExplicitlyUncharged(message: string): boolean {
  const m = message.toLowerCase();
  return m.includes("no payment was made") ||
    m.includes("no payment was taken") ||
    m.includes("no payment taken") ||
    m.includes("no charge was made") ||
    m.includes("nothing was charged") ||
    m.includes("not charged");
}

