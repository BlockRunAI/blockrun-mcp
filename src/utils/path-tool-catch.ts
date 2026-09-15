// src/utils/path-tool-catch.ts
//
// The one catch block for the seven path-based tools (search, exa, markets,
// rpc, defi, phone, modal). They let the SDK — or, on the account rail,
// utils/api-key-call.ts — own the paid request, so by the time an error
// reaches them the only evidence of what happened to the money is the error
// itself. Until audit round 3 every one of them did
// `formatError(extractErrorMessage(err))` and nothing else: a call that
// settled and then failed booked $0 against the cap, and the text said "try
// again in a few minutes" (C38).
//
// WHAT GETS BOOKED, AND WHY NOT MORE. The SDK throws "API error after payment"
// before it records any spend, on both wallet rails, so a settled-then-failed
// call never reaches the counter. But the same prefix covers two very
// different 5xx: the gateway's catch-all 500 AFTER settlement (the pm route
// awaits the upstream body inside the same try — money gone, no marker) and
// the search route's Grok failure BEFORE settlement (also a bare 500 "Internal
// server error" — no money moved). The client cannot tell those apart, and
// booking both would re-create the invented spend 0.49.0 removed: a 30-second
// Grok blip would book $0.26 of phantom search spend per call. So the rule is
// narrower than settlementOnThrow's "unknown":
//
//   book when the payment was sent AND no response from the ORIGIN was seen —
//   a transport failure (abort, timeout, reset) or an edge status that means
//   the origin did not answer (502/504/52x) — AND the message carries no
//   uncharged marker.
//
// A gateway-authored 5xx with a body (500, 503) after payment is NOT booked;
// formatError still hedges it ("the charge MAY have gone through"), because
// the text can afford to be uncertain where the ledger cannot afford to be
// wrong in the permissive direction twice a minute.

import type { BudgetState } from "../types.js";
import { recordActualSpend } from "./budget.js";
import { settlementOnThrow } from "./chat-stream.js";
import { isApiKeyMode } from "./auth.js";
import { ledgerFallback } from "./raw-call.js";
import { basePaymentReplayHedge, extractErrorMessage, formatError, isExplicitlyUncharged } from "./errors.js";

// Statuses an edge or a load balancer returns when the ORIGIN did not answer
// in time — the origin may still be running the request and settle it after
// the client is gone. Mirrors ORIGIN_DID_NOT_ANSWER in utils/chat-stream.ts
// (not exported there); keep the two in step.
const ORIGIN_DID_NOT_ANSWER = new Set([408, 502, 504, 520, 521, 522, 523, 524, 525, 526, 527, 529, 530]);

function statusOf(err: unknown): number | undefined {
  const e = err as { statusCode?: unknown; status?: unknown } | undefined;
  if (typeof e?.statusCode === "number") return e.statusCode; // @blockrun/llm APIError
  if (typeof e?.status === "number") return e.status;
  return undefined;
}

export interface PathToolFailureOpts {
  budget: BudgetState;
  agentId?: string;
  /**
   * The reserve of the paid request that was IN FLIGHT when `err` was thrown,
   * or 0 when no paid request had been sent yet (validation, the budget gate,
   * a declined confirmSpend, a client that could not be built). The caller
   * sets it on the line before rawGet/rawPost — never earlier, or a keychain
   * error whose text happens to say "timeout" books a render.
   */
  sentUsd: number;
  /** Vendor name for the Base-only replay hedge (exa, defi), when the route has that ambiguity. */
  replayUpstream?: string;
  /**
   * Route-specific rendering that REPLACES formatError's text when it returns
   * a string (markets' degraded sports/* formatter). Booking is unaffected.
   */
  describe?: (message: string) => string | null;
}

// A type alias, not an interface: the MCP SDK's CallToolResult carries an
// index signature, and an interface without one is not assignable to it.
export type PathToolFailure = {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError: true;
};

/**
 * Render a path tool's failure and book the charge when it may have settled.
 * Returns the MCP error result the handler returns as-is.
 */
export function pathToolFailure(err: unknown, opts: PathToolFailureOpts): PathToolFailure {
  const message = extractErrorMessage(err);
  const rail = isApiKeyMode() ? "account" : "wallet";
  const verdict = settlementOnThrow(err, { rail, estimateUsd: opts.sentUsd });
  const status = statusOf(err);
  // "unknown" is the necessary condition (the payment went out, no verdict came
  // back); the status test is the sufficient one — see the header comment.
  const originSilent = status === undefined || ORIGIN_DID_NOT_ANSWER.has(status);
  const mayHaveSettled = verdict === "unknown" && originSilent && !isExplicitlyUncharged(message);

  let bookedUsd = 0;
  if (mayHaveSettled) {
    // Same conservative direction video/music/in-flight already take: over-
    // counting a request that settled nothing is recoverable against the wallet;
    // under-counting a real charge drifts the cap permissive and the message
    // invites a second payment. paidUsd is null — nothing was observed.
    bookedUsd = ledgerFallback(opts.sentUsd);
    recordActualSpend(opts.budget, null, bookedUsd, opts.agentId);
  }

  const bespoke = opts.describe?.(message) ?? null;
  let text = bespoke ?? formatError(message, { afterPayment: verdict === "unknown" });
  if (mayHaveSettled) {
    text += ` $${bookedUsd.toFixed(4)} has been booked against your budget as a precaution.`;
  }
  if (opts.replayUpstream) text += basePaymentReplayHedge(message, opts.replayUpstream);
  return { content: [{ type: "text", text }], isError: true };
}
