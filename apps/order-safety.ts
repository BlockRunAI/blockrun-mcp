// apps/order-safety.ts
//
// The two questions the order card has to answer after a submit fails, split
// out of the DOM so they can be tested as logic rather than grepped out of a
// minified bundle.
//
// Both exist because of the same asymmetry: a card that re-arms after an
// ambiguous failure reads as "nothing happened, try again", and one more click
// is a second real-money order at the CLOB. Re-arming is only safe when we KNOW
// nothing was signed.

/**
 * Did the server's own error say the money did not move?
 *
 * The server knows whether it signed; when it does, it says so in the wording
 * this repo standardised on ("no charge was made", "Nothing withdrawn", …).
 * Anything else — a bare failure, a transport error, a timeout — is
 * outcome-unknown and must NOT re-arm the card.
 */
export function outcomeIsUnknown(text: string): boolean {
  const t = text.toLowerCase();
  const uncharged =
    /no charge was made|no payment was made|no payment was taken|no payment taken|nothing was charged|not charged|nothing withdrawn|refusing to sign/.test(t);
  return !uncharged;
}

/**
 * Did the user decline a consent prompt? That signs nothing, it is the
 * commonest reason the submit throws, and it is the one throw that may safely
 * restore the card to its pre-click state.
 */
export function declinedByUser(message: string): boolean {
  const m = message.toLowerCase();
  return /declin|denied|cancell?ed|rejected by (the )?user|not approved|permission/.test(m);
}
