// src/utils/in-flight.ts
//
// One answer to the one question every paid tool's catch has to ask: when this
// error was thrown, had a request CARRYING A PAYMENT already left the machine?
//
// The gateway settles on its own clock and does not stop because the client
// disconnected. So a paid POST that never answered is not "no charge": the
// signature (or the account Bearer) went out, the gateway may well have taken
// the money and finished the render, and the tool's job is to book that
// conservatively and say so — the natural next move after a bare "failed" is
// to run the call again, which pays a second time.
//
// 0.50.0 tried to do this with a `paidRequestInFlight` boolean copied into
// each tool by hand, and every copy was wrong in its own way (audit round 3):
//
//   - speech, realface and image cleared the flag in a `.finally()` chained on
//     the very fetch they were guarding. Promise#finally runs its callback
//     BEFORE the rejection reaches the awaiting catch, so the catch always
//     read `false` and the booking branch was unreachable — dead code that
//     the rail-parity matrix greenlit because the identifier existed;
//   - speech set it on Base only; image's Base rail never set it;
//   - realface's flag was module-global, so a concurrent call's outstanding
//     payment made an unrelated failure book a phantom charge;
//   - image's Solana branch armed it BEFORE the unpaid 402 probe, so a probe
//     timeout — nothing signed, nothing sent with a signature — booked a
//     full render against the cap.
//
// This module replaces the flag with a per-call tracker and two rules:
//
//   1. arm() only when something has been signed / the paid request is about
//      to be sent — never around the unpaid quote probe. On Base and the
//      account rail that is the line before the paid fetch; on Solana the
//      helper (utils/solana-402.ts) owns the sequence and fires onPaidRequest
//      the line before the signed request leaves, so tools arm there.
//   2. settle() the moment a RESPONSE arrives — any status, before it is
//      inspected. A 402/4xx/5xx that came back is an answer: the gateway told
//      us what it did, and the catch must not turn it into "may have settled".
//      A rejection leaves the tracker armed; that is the whole point.
import type { BudgetState } from "../types.js";
import { recordActualSpend } from "./budget.js";
import { isTimeoutError } from "./http.js";
import { isApiKeyMode } from "./auth.js";
import { isExplicitlyUncharged, ORIGIN_DID_NOT_ANSWER } from "./uncharged.js";

// Literal rather than PORTAL_ACTIVITY_URL: every handler test that mocks
// utils/auth.js lists its named exports by hand, and the one name this module
// cannot do without is isApiKeyMode. (api-key-call.ts spells the URL out for
// the same reason.)
const ACCOUNT_ACTIVITY_URL = "https://user.blockrun.ai/dashboard/activity";

/**
 * A per-call record of whether a request carrying a payment is outstanding.
 * Create one per handler invocation (never at module scope — the MCP SDK
 * dispatches tool calls concurrently) and hand it to whatever performs the
 * paid request on the active rail.
 */
export interface PaidRequest {
  /**
   * The paid request is about to be sent (a signature exists, or the Bearer
   * is on the request). `quotedUsd` is the authoritative 402 amount when the
   * rail has one; a give-up books it in preference to the caller's estimate.
   */
  arm(quotedUsd?: number | null): void;
  /** A response arrived — whatever its status. The outcome is now known. */
  settle(): void;
  /** True between arm() and settle(): the payment MAY have settled server-side. */
  readonly outstanding: boolean;
  /** The quote captured at arm() time, if any. */
  readonly quotedUsd: number | null;
  /**
   * True when `err` was thrown while a paid request was outstanding AND the
   * error is the kind that means "no response was observed" — a timeout, an
   * abort, a socket that dropped mid-flight. A response that did arrive and
   * was then rejected by the caller (a 402, an API error) is not this — nor an
   * error that CARRIES the answer (a status, a typed job verdict, the
   * gateway's uncharged marker; see isAnswer) — nor a connection that
   * provably never opened (DNS failed, connection refused), because nothing
   * could have reached the gateway.
   */
  mayHaveSettled(err: unknown): boolean;
}

/**
 * Rejection causes that prove the request never left this machine. Mirrors
 * the set utils/api-key-call.ts uses for the account rail's async submit; a
 * request that was never accepted by a socket cannot have been billed.
 */
const NEVER_CONNECTED = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "EADDRNOTAVAIL"]);

/**
 * The request went out and nothing came back. undici surfaces every transport
 * failure as `TypeError: fetch failed` with the real reason in `cause`, so the
 * cause code is what is classified; fetchWithTimeout's own abort arrives as a
 * DOMException named AbortError, which isTimeoutError already recognises.
 */
function noResponseObserved(err: unknown): boolean {
  if (isAnswer(err)) return false;
  const e = err as { cause?: { code?: unknown } } | undefined;
  // An edge status on the paid request: the request left, the origin did not
  // answer — the same "no verdict" as a dropped socket, and booked the same.
  const status = statusOf(err);
  if (status !== undefined && ORIGIN_DID_NOT_ANSWER.has(status)) return true;
  const cause = e?.cause;
  const code = typeof cause?.code === "string" ? cause.code : "";
  if (NEVER_CONNECTED.has(code)) return false;
  if (isTimeoutError(err)) return true;
  if (err instanceof TypeError && /fetch failed/i.test(err.message)) return true;
  return /^(ECONNRESET|EPIPE|ETIMEDOUT|UND_ERR_)/.test(code);
}

/**
 * An error that IS the gateway's answer, thrown by a helper AFTER a response
 * arrived — so settle() was never reached, but nothing is outstanding.
 *
 * sendPaid can only settle when the wrapped call resolves; a helper that
 * inspects the response and throws on it (apiKeyPost's AccountApiError with
 * the body text, apiKeyAsyncPost's not_charged terminal failure, the Solana
 * helper's "API error N:") leaves the tracker armed with an answer in hand.
 * Until audit round 4 the verdict then fell to isTimeoutError's substring
 * match on the message, and a not_charged poll whose upstream text read "The
 * operation was aborted due to timeout" booked a whole render on image's
 * account rail and said "MAY have gone through" — the C13 shape, on the rail
 * whose sibling tools had just documented why it must not happen. So the
 * answer is read off the error, never its prose: a numeric status (the SDK's
 * APIError.statusCode, AccountApiError, the Anthropic SDK's .status), a typed
 * job verdict, or the gateway's own uncharged marker.
 */
function isAnswer(err: unknown): boolean {
  const e = err as { name?: unknown; message?: unknown } | undefined;
  if (e?.name === "JobFailedError" || e?.name === "BilledJobError") return true;
  if (typeof e?.message === "string" && isExplicitlyUncharged(e.message)) return true;
  const status = statusOf(err);
  // A status is the gateway's verdict — unless it is an EDGE status, which
  // says only that the origin did not answer in time: it may still be running
  // the request and settling it. Round 4 read every number as an answer and
  // undid, for the media tools alone, the rule chat and the path tools apply
  // to the same status on the same rails (round 4b, P1).
  return status !== undefined && !ORIGIN_DID_NOT_ANSWER.has(status);
}

/** The status on an error, when it carries one (SDK APIError / AccountApiError `statusCode`, Anthropic SDK `status`). */
function statusOf(err: unknown): number | undefined {
  const e = err as { statusCode?: unknown; status?: unknown } | undefined;
  return typeof e?.statusCode === "number" ? e.statusCode : typeof e?.status === "number" ? e.status : undefined;
}

export function trackPaidRequest(): PaidRequest {
  let armed = false;
  // Once true, a request carrying the payment has LEFT at least once. Kept
  // apart from `armed`: an edge status settles the tracker (a response did
  // arrive) and still means the origin may be running the request.
  let sent = false;
  let quoted: number | null = null;
  return {
    arm(quotedUsd) {
      armed = true;
      sent = true;
      if (typeof quotedUsd === "number" && Number.isFinite(quotedUsd) && quotedUsd > 0) quoted = quotedUsd;
    },
    settle() {
      armed = false;
    },
    get outstanding() {
      return armed;
    },
    get quotedUsd() {
      return quoted;
    },
    mayHaveSettled(err) {
      // An edge status on a request that carried the payment is a maybe
      // whether or not the tracker was settled by its arrival — the
      // gateway's own uncharged marker is the only thing that overrules it.
      const status = statusOf(err);
      if (sent && status !== undefined && ORIGIN_DID_NOT_ANSWER.has(status)) {
        const msg = err instanceof Error ? err.message : String(err);
        return !isExplicitlyUncharged(msg);
      }
      return armed && noResponseObserved(err);
    },
  };
}

/**
 * Run the paid request with the tracker armed, and settle it only when a
 * response comes back. A rejection propagates with the tracker still armed —
 * the shape `await send().finally(() => settle())` must never come back,
 * because finally runs before the rejection reaches the catch.
 *
 *   const resp = await sendPaid(paid, () => fetchWithTimeout(url, { headers: { "PAYMENT-SIGNATURE": sig } }, ms), quotedUsd);
 *
 * Use this on the rails where the caller issues the paid request itself
 * (Base's signed resubmit, the account rail's Bearer POST, the SDK-owned
 * ImageClient call). On Solana the sequence lives inside solanaPaidPost /
 * solanaPaidAsyncPost, which offer `onPaidRequest` / `onPaidResponse` — the
 * exact edges of every request carrying the signature — so arm() and
 * settle() from those hooks and capture the quote in onQuote for arm() to
 * book. (Round 3 armed at onQuote, one step early: a signing-time RPC
 * failure read as "may have settled". Round 4 moved image, speech and
 * realface to the hooks alone; video and music arm at BOTH — onQuote for the
 * async helper's signing window and the hooks for every later request — and
 * accept that residual window on purpose, documented in video.ts.)
 *
 * NOT for a helper that bills on its own and classifies its own exits
 * (apiKeyAsyncPost: BilledJobError / JobFailedError). Wrapping one leaves
 * the tracker armed across a verdict the helper already reached; video,
 * music and image call it bare.
 */
export async function sendPaid<T>(paid: PaidRequest, send: () => Promise<T>, quotedUsd?: number | null): Promise<T> {
  paid.arm(quotedUsd);
  const out = await send();
  paid.settle();
  return out;
}

/**
 * The catch-side half. When the tracker says a paid request was outstanding
 * and `err` means no response was observed, book the charge (the captured
 * quote, else the caller's reserve) and return the sentence the caller must
 * show — one that says what is and is not known and where to check. Returns
 * null when nothing could have settled, so the caller falls through to its
 * usual error formatting.
 *
 * Booking here is the documented trade-off video and music already make:
 * over-counting a request that settled nothing is recoverable (the report
 * can be reconciled against the wallet), under-counting a real charge is not
 * (the cap drifts permissive and the message invites a second payment).
 */
export function settleGiveUp(
  paid: PaidRequest,
  err: unknown,
  opts: {
    budget: BudgetState;
    agentId?: string;
    /** What was reserved at the gate — booked when no quote was captured. */
    estimateUsd: number;
    /** Sentence subject, e.g. "Speech generation" or "RealFace enroll". */
    what: string;
    /** Extra sentence appended before the error line (e.g. a reclaim note). */
    note?: string;
  },
): { text: string; bookedUsd: number } | null {
  if (!paid.mayHaveSettled(err)) return null;
  const bookedUsd = paid.quotedUsd ?? Math.max(0, opts.estimateUsd);
  recordActualSpend(opts.budget, paid.quotedUsd, opts.estimateUsd, opts.agentId);
  const errMsg = err instanceof Error ? err.message : String(err);
  const account = isApiKeyMode();
  const carrying = account ? "the account key" : "the payment signature";
  const where = account
    ? `check blockrun_wallet action:"report" and ${ACCOUNT_ACTIVITY_URL}`
    : `check blockrun_wallet action:"report" or the wallet's recent transactions`;
  return {
    bookedUsd,
    text:
      `${opts.what} got no answer while a request carrying ${carrying} was still in flight, so the charge MAY have gone through — ` +
      `the gateway settles on its own clock and does not stop because this client gave up. ` +
      `$${bookedUsd.toFixed(4)} has been booked against your budget; ${where} before retrying.` +
      (opts.note ? ` ${opts.note}` : "") +
      `\nError: ${errMsg}`,
  };
}
