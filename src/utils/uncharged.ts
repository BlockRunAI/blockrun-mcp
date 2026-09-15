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


/**
 * Statuses an edge or a load balancer returns when the ORIGIN did not answer
 * in time. The origin may still be running the request and settle it after
 * the client is gone (the Cloud Run route documents that a client disconnect
 * is never propagated to a non-streaming handler), so a paid request that
 * came back with one of these is NOT an answer — it is the same "no verdict"
 * as a dropped socket. Everything else in the 4xx/5xx range is the gateway
 * itself answering, which it does before settlement starts. One set, shared
 * by chat (settlementOnThrow), the path tools (pathToolFailure) and the media
 * tools (in-flight isAnswer): round 4b found the media copy missing, so a
 * blockrun_speech answered 504 by the edge while TTS finished and billed at
 * the origin read "failed — try again", i.e. pay twice, on the same rail where
 * blockrun_exa booked the same status as a precaution.
 */
export const ORIGIN_DID_NOT_ANSWER: ReadonlySet<number> = new Set([408, 502, 504, 520, 521, 522, 523, 524, 525, 526, 527, 529, 530]);
