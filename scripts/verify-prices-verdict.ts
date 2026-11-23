// scripts/verify-prices-verdict.ts — the exit decision of `npm run verify:prices`.
//
// Split out of verify-prices.ts so the decision can be tested without probing
// the network (the script itself is top-level `await` over sixty live 402
// probes and cannot be imported by a test). Pure: tallies in, exit code and
// summary lines out.
//
// WHY THIS IS ITS OWN DECISION: only a confirmed under-reserve failed the run.
// `unreachable` — no 402, an undecodable header, a missing `amount` — printed a
// warning and exit 0, so the day the gateway renamed a header field every row
// printed `?` and the release gate went green having verified nothing. A gate
// that cannot tell "checked and fine" from "could not check" is not a gate.
//
// Exit codes are deliberately distinct so a caller can tell them apart:
//   0  every probe and every catalogue was read, nothing under-reserves
//   1  a CONFIRMED under-reserve — an estimator, or the price table, reserves
//      less than a gateway charges. Fix the estimator before publishing.
//   2  the run could not verify enough to say: more than UNREACHABLE_FRACTION
//      of the routes, or any catalogue, could not be read. Fix the probe (or
//      wait out the outage) and run again. NEVER read as pass.
// When both apply, 1 wins — money is the more urgent message — but the
// unverified rows are still named so a partial run is never mistaken for a
// complete one.

export type Tally = {
  /** Routes the script tried to probe. */
  probes: number;
  /** Base charges more than the estimator reserves. */
  short: number;
  /** Solana charges more than the estimator reserves. */
  solShort: number;
  /** Probes that produced no usable quote (no 402, bad header, no `amount`). */
  unreachable: number;
  /** Live chat models the price table under-reserves (any catalogue). */
  catalogueGaps: number;
  /** Catalogues the script tried to read (Base, Solana, the account-rail sheet). */
  catalogues: number;
  /** Catalogues that could not be read. */
  catalogueUnreachable: number;
};

export type Verdict = { code: 0 | 1 | 2; lines: string[] };

/**
 * A quarter. A single transient miss (one route mid-deploy, one 5xx) should
 * not block a release — the row prints `?` and the operator re-runs. A quarter
 * of the matrix is not transient: at that point the probe method or the
 * network is broken, and "verified" would be a lie about 15+ estimators.
 */
export const UNREACHABLE_FRACTION = 0.25;

export function verdict(t: Tally): Verdict {
  const lines: string[] = [];

  const unverified = t.probes === 0 || t.unreachable > t.probes * UNREACHABLE_FRACTION;
  if (t.probes === 0) {
    lines.push("no routes were probed — the probe list is empty, so nothing was verified.");
  } else if (unverified) {
    lines.push(
      `${t.unreachable} of ${t.probes} routes could not be verified (above the ${UNREACHABLE_FRACTION * 100}% tolerance). ` +
        "Their estimators are NOT verified — fix the probe (has the 402 header shape changed?) or the network, then run again.",
    );
  } else if (t.unreachable) {
    lines.push(
      `${t.unreachable} unreachable route${t.unreachable === 1 ? "" : "s"} were NOT verified — treat them as unknown, not as passing.`,
    );
  }
  if (t.catalogueUnreachable) {
    lines.push(
      `${t.catalogueUnreachable} of ${t.catalogues} price catalogues could not be read. ` +
        "The catalogue sweep is the only check that sees a model the price table does NOT list — an unread catalogue is NOT verified.",
    );
  }

  const money = t.short || t.solShort || t.catalogueGaps;
  if (money) {
    const why = [
      t.short || t.solShort ? `an estimator reserves less than the gateway charges${t.solShort ? " (on Solana)" : ""}` : "",
      t.catalogueGaps
        ? `${t.catalogueGaps} live chat model${t.catalogueGaps === 1 ? "" : "s"} disagree${t.catalogueGaps === 1 ? "s" : ""} with the price table in a direction that costs money`
        : "",
    ].filter(Boolean).join("; ");
    lines.push(`FAIL: ${why}. Fix it before publishing.`);
    return { code: 1, lines };
  }
  if (unverified || t.catalogueUnreachable) {
    lines.push("UNVERIFIED: this run could not check enough to pass. Exit 2 — not a pass, not a confirmed under-reserve.");
    return { code: 2, lines };
  }
  return { code: 0, lines };
}

/** One `pricing.long_context` step as a catalogue publishes it (fields unchecked). */
export type LongContextStep = { threshold?: unknown; inclusive?: unknown; input?: unknown; output?: unknown };

/**
 * Read a catalogue row's `pricing.long_context`. The gateway contract (blockrun
 * CAT-040/041) is a LIST of steps. Until 2026-11-23 the Decisions entry
 * (`openai/gpt-6-luna-decisions`) published a bare `{threshold, input}` object,
 * and iterating it with `for…of` threw and killed the whole run. A non-list is
 * now reported as malformed — a contract breach the caller counts as a gap —
 * instead of crashing the sweep or being skipped silently.
 */
export function longContextSteps(raw: unknown): { steps: LongContextStep[]; malformed: boolean } {
  if (raw === undefined || raw === null) return { steps: [], malformed: false };
  if (Array.isArray(raw)) return { steps: raw as LongContextStep[], malformed: false };
  return { steps: [], malformed: true };
}

/**
 * The chat platform fee a catalogue row publishes, in percent (blockrun PF-8):
 * `pricing.platform_fee_percent` (both gateways), else the row's top-level
 * `platform_fee_percent` (Base also puts it there), else 0. Only a finite,
 * non-negative number counts; anything else falls through, the same reading as
 * ClawRouter's platformFeePercentOf (ClawRouter#622). A nested value wins even
 * when it is 0.
 */
export function platformFeePercentOf(row: { platform_fee_percent?: unknown; pricing?: { platform_fee_percent?: unknown } }): number {
  const valid = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
  const nested = row.pricing?.platform_fee_percent;
  if (valid(nested)) return nested;
  const top = row.platform_fee_percent;
  return valid(top) ? top : 0;
}
