// src/utils/solana-402.ts
// Manual x402 payment flow against the Solana gateway (sol.blockrun.ai) for
// paid endpoints the SolanaLLMClient doesn't expose as public methods:
// solanaPaidPost for the routes that answer inline (image, speech, realface —
// synchronous optimistic settle) and solanaPaidAsyncPost for the async ones
// (video, music — submit + poll). Mirrors the manual-402 pattern the tools use
// on Base, but signs an SPL transfer via createSolanaPaymentPayload instead of
// an EIP-3009 authorization.
//
// Two settlement models share solanaPaidAsyncPost, and the gateway tells us
// which one a route follows on the submit answer:
//
//   payment-on-completion (video)  the POST verifies and enqueues; the charge
//                                  happens on the poll that observes
//                                  "completed", with the signature it carries.
//                                  A failed job is not charged.
//   settled-at-submit (music)      the POST settles the transfer optimistically
//                                  the moment it is accepted (202 with
//                                  payment_status "settled_optimistic" and the
//                                  X-Payment-Optimistic header; blockrun-sol
//                                  audio/generations/route.ts). The polls are
//                                  pure delivery, so a failed job, a deadline
//                                  or a poll error is a CERTAIN charge.
//
// Until audit round 3 the helper assumed the first model for every route and
// said "No payment was taken" for a failed music job the gateway had already
// settled.
import {
  SolanaLLMClient,
  PaymentError,
  parsePaymentRequired,
  extractPaymentDetails,
  createSolanaPaymentPayload,
  solanaKeyToBytes,
  solanaPublicKey,
  SOLANA_NETWORK,
} from "@blockrun/llm";
import { fetchWithTimeout } from "./http.js";
import { JobFailedError, pollTimeoutFor } from "./poll.js";
import { resolveSolanaKey } from "./wallet.js";
import { amountToUsd } from "./budget.js";
import { BilledJobError } from "./api-key-call.js";

const QUOTE_TIMEOUT_MS = 15_000;

// Timing for the payment-on-completion loop (solanaPaidAsyncPost). Unlike the
// Base video loop there is no EIP-3009 validBefore to stay inside: the signed
// SPL transaction carries a recent blockhash that the cluster honours for
// ~60s of block time, and the gateway settles on the poll that observes
// "completed" — with the signature it RECEIVES on that poll. What has to stay
// fresh is therefore the signature's age at send time, which is at most
//
//   RESIGN_INTERVAL + POLL_INTERVAL (sleep) + one RPC round-trip
//
// The SDK fetches the blockhash at `finalized` commitment (already ~13s old)
// and caches it for 10s, so a 45s interval routinely presented a 70s+
// signature and turned the bounded reactive path into the normal path. 20s
// keeps the worst case near 40s. The poll GET itself is capped at the Solana
// poll route's own maxDuration (60s) rather than Base's 90s: a stalled poll
// is the one place the signature ages without a re-sign, and the gateway
// can't answer past 60s anyway. Submit gets Base's 30s — the VIDEO gateway
// verifies and enqueues in 3-20s, and a 300s hold here was silently adding
// five minutes to the "15 min hard cap" the tool description promises. It is
// a default, not a rule: the audio route holds the paid POST inline for up to
// 60s and settles at POST regardless, so a 30s abort there was a charged track
// with no job id (C15) — music.ts passes its own submitTimeoutMs.
export const SOLANA_ASYNC_DEFAULT_BUDGET_MS = 900_000;
export const SOLANA_ASYNC_POLL_INTERVAL_MS = 5_000;
export const SOLANA_ASYNC_SUBMIT_TIMEOUT_MS = 30_000;
export const SOLANA_ASYNC_POLL_TIMEOUT_MS = 60_000;
export const SOLANA_ASYNC_RESIGN_INTERVAL_MS = 20_000;
// A failed proactive re-sign (RPC blip) waits this long before trying again
// instead of re-deriving the key and hitting the RPC on every 5s iteration.
export const SOLANA_ASYNC_RESIGN_RETRY_MS = 10_000;
export const SOLANA_ASYNC_MAX_REACTIVE_RESIGNS = 3;

// Settle-failure reasons the Solana gateway itself treats as permanent for the
// presented authorization (together they mirror PERMANENT_ERRORS in the
// gateway's x402-solana.ts). Anything else on a poll 402 — stale blockhash, a
// concurrent settle claim, a facilitator hiccup — is the gateway's documented
// "re-sign and re-poll" path and must not be reported as a funding problem.
//
// The permanent set is split by REMEDY. Only "insufficient" is the wallet; the
// rest are the signature or the authorization, and a user whose payload was
// malformed or whose authorization expired was being told to fund a wallet
// that had plenty in it — and, on Base, handed a Coinbase top-up page — because
// the one message said "rejected … balance" and every tool's catch keyed on
// those words (audit round 3, D2).
const FUNDING_SETTLE_PATTERNS = ["insufficient"];
const INVALID_AUTH_SETTLE_PATTERNS = [
  "invalid signature",
  "invalid payment",
  "unauthorized",
  "forbidden",
  "invalid_payload",
  "expired",
];
function matches(reason: string | undefined, patterns: string[]): boolean {
  if (!reason) return false;
  const lower = reason.toLowerCase();
  return patterns.some((p) => lower.includes(p));
}
const isFundingFailure = (reason: string | undefined) => matches(reason, FUNDING_SETTLE_PATTERNS);
const isInvalidAuthFailure = (reason: string | undefined) => matches(reason, INVALID_AUTH_SETTLE_PATTERNS);

/**
 * The error for a 402 that came back on a request CARRYING the signature. A
 * funding reason (or no reason at all — the gateway's verification 402 does
 * not always carry PAYMENT-RESPONSE) is a PaymentError, which the tools turn
 * into "out of funds" plus the top-up note. An authorization reason is a plain
 * Error whose text deliberately contains none of "rejected" / "balance" /
 * "insufficient" — isPaymentRejectionError (utils/errors.ts) keys on exactly
 * those — and does contain "no charge was made", which formatError honours.
 */
function paidRequestRefused(reason: string | undefined, where: string, tail = ""): Error {
  if (reason && isInvalidAuthFailure(reason) && !isFundingFailure(reason)) {
    return new Error(
      `The Solana gateway refused the payment signature ${where} (reason: ${reason}) — a signing/authorization fault, not a funding problem. ` +
        `No charge was made.${tail ? ` ${tail}` : ""}`,
    );
  }
  return new PaymentError(`Payment was rejected${reason ? ` (${reason})` : ""}. Check your Solana USDC balance.${tail ? ` ${tail}` : ""}`);
}

/**
 * The key, or the honest reason there is none. Two reasons, two remedies:
 * a keychain that would not open is NOT a missing wallet — the wallet is very
 * likely there and funded, and "run setup" invites a second one. 783cfb3
 * taught buildSolanaClient (wallet.ts) that distinction and left the manual-402
 * helpers saying the old thing (audit round 3, D3/D30). Neither is a
 * PaymentError: image's catch turns one into "your wallet is out of funds".
 *
 * solanaKeyUnavailableReason is imported dynamically so the handler suites
 * that mock utils/wallet.js by name (and predate it) keep linking — image.ts
 * imports this module statically. Only the failure path pays for the import.
 */
async function requireSolanaKey(): Promise<string> {
  // resolveSolanaKey, not the SDK's file-only loader: under
  // BLOCKRUN_KEYCHAIN=strict the .solana-session file is retired once its key
  // is in the OS keychain, and getChain() still reports "solana" for it.
  const privateKey = resolveSolanaKey();
  if (privateKey) return privateKey;
  const { solanaKeyUnavailableReason } = await import("./wallet.js");
  const locked = solanaKeyUnavailableReason?.();
  if (locked) {
    throw new Error(
      `Cannot reach your Solana wallet key — ${locked}. Your existing wallet is most likely still in the keychain: ` +
        `unlock it and retry, or set SOLANA_WALLET_KEY. Nothing was charged.`,
    );
  }
  throw new Error(
    `No Solana wallet on this machine yet. Run blockrun_wallet action:"setup" (or action:"chain" chain:"solana") to create one, ` +
      `or set SOLANA_WALLET_KEY. Nothing was charged.`,
  );
}

/** errorReason from a base64 x402 PAYMENT-RESPONSE header, when present and well-formed. */
function settleFailureReason(response: Response): string | undefined {
  const raw = response.headers.get("payment-response") || response.headers.get("PAYMENT-RESPONSE");
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as { errorReason?: unknown };
    return typeof parsed.errorReason === "string" && parsed.errorReason ? parsed.errorReason : undefined;
  } catch {
    return undefined;
  }
}

export interface SolanaPaidPostResult {
  data: Record<string, unknown>;
  /** Actual USD charged, from the 402 quote. Null when unparseable — callers fall back to their estimate. */
  paidUsd: number | null;
  /** Settlement receipt from the terminal response, when the gateway returns one. */
  txHash?: string;
  /** Gateway job id for async flows — the handle a user needs to reclaim a finished clip. */
  jobId?: string;
}

/**
 * The two hooks that mark the edges of every request CARRYING the payment.
 * Offered by both helpers so a tool's in-flight tracker (utils/in-flight.ts)
 * can be armed at the true signing point and settled on every answer, instead
 * of guessing from onQuote — which fires before the transfer is signed, so a
 * signing-time RPC failure read as "may have settled".
 */
export interface PaidRequestHooks {
  /**
   * Invoked immediately before a request carrying PAYMENT-SIGNATURE is sent:
   * the submit, and (async) every paid poll. Never around the unpaid quote or
   * the unpaid re-sign challenge. A request that is sent and never answered
   * leaves this as the last hook that fired — which is the point.
   */
  onPaidRequest?: () => void;
  /** Invoked the moment such a request has an answer — any status, before it is inspected. */
  onPaidResponse?: () => void;
}

export interface SolanaPaidAsyncPostOptions extends PaidRequestHooks {
  /**
   * Total wall time allowed for quote + submit + polling, measured from the
   * call's entry. Defaults to SOLANA_ASYNC_DEFAULT_BUDGET_MS (15 minutes).
   */
  pollBudgetMs?: number;
  /** Delay between idempotent poll GETs. Defaults to SOLANA_ASYNC_POLL_INTERVAL_MS. */
  pollIntervalMs?: number;
  /**
   * Timeout for the single paid submit POST. Defaults to
   * SOLANA_ASYNC_SUBMIT_TIMEOUT_MS, which is sized for the video route (verify
   * + enqueue, always 202 in 3-20s). A route that holds the paid POST inline —
   * the audio route races generation against a 60s window and settles at
   * POST regardless — needs its own, larger value (music.ts).
   */
  submitTimeoutMs?: number;
  /**
   * Sentence subject for every error this helper throws, e.g. "Music
   * generation". Defaults to "Video generation", the helper's first caller —
   * music surfaced "Video generation did not complete" and "re-running
   * blockrun_video" verbatim until it passed its own (audit round 3, D1/D22).
   */
  what?: string;
  /** The tool name the reclaim note warns about re-running. Defaults to "blockrun_video". */
  tool?: string;
  /** Timeout for each poll GET (always clamped to the remaining budget). Defaults to SOLANA_ASYNC_POLL_TIMEOUT_MS. */
  pollTimeoutMs?: number;
  /** Re-sign the SVM transaction (fresh blockhash) this often. Defaults to SOLANA_ASYNC_RESIGN_INTERVAL_MS. */
  resignIntervalMs?: number;
  /** Maximum reactive re-signs after a completed poll rejects a stale signature. Defaults to SOLANA_ASYNC_MAX_REACTIVE_RESIGNS. */
  maxReactiveResigns?: number;
  /**
   * Called after the authoritative quote is parsed and before anything is
   * signed. `details` is the decoded 402 (amount, recipient, resource
   * description) so a caller can check WHAT was quoted, not just how much.
   */
  onQuote?: (quotedUsd: number | null, details: ReturnType<typeof extractPaymentDetails>) => void;
}

type SolanaPaymentContext = {
  paymentRequired: ReturnType<typeof parsePaymentRequired>;
  details: ReturnType<typeof extractPaymentDetails>;
  paidUsd: number | null;
};

async function readPaymentRequired(response: Response): Promise<string> {
  let header = response.headers.get("payment-required") || response.headers.get("PAYMENT-REQUIRED");
  if (!header) {
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (body && (body.accepts || body.x402Version)) {
      header = Buffer.from(JSON.stringify(body)).toString("base64");
    }
  }
  // A gateway fault, not a funding problem — plain Error, like every other
  // refusal of a quote we could not validate. PaymentError is reserved for a
  // 402 on a request that CARRIED the signature (the tools' "out of funds").
  if (!header) throw new Error("402 response but no payment requirements found. No charge was made.");
  return header;
}

function parseSolanaChallenge(paymentHeader: string): SolanaPaymentContext {
  const paymentRequired = parsePaymentRequired(paymentHeader);
  const details = extractPaymentDetails(paymentRequired, SOLANA_NETWORK);
  if (!details.network?.startsWith("solana:")) {
    throw new Error(`Expected a Solana payment quote, got network: ${details.network}. The endpoint may not support Solana settlement yet. No charge was made.`);
  }
  const feePayer = (details.extra as { feePayer?: string } | undefined)?.feePayer;
  if (!feePayer) throw new Error("Missing feePayer in the 402 quote's extra field. No charge was made.");
  return { paymentRequired, details, paidUsd: amountToUsd(details.amount) };
}

async function signSolanaChallenge(
  context: SolanaPaymentContext,
  url: string,
  privateKey: string,
): Promise<string> {
  const apiUrl = SolanaLLMClient.SOLANA_API_URL;
  const { paymentRequired, details } = context;
  const feePayer = (details.extra as { feePayer: string }).feePayer;
  // Only sign for a resource on the gateway's own origin — a spoofed quote must
  // not relabel the payment as authorizing some other resource.
  const quotedResource = details.resource?.url;
  const resourceUrl = quotedResource && quotedResource.startsWith(apiUrl) ? quotedResource : url;
  const fromAddress = await solanaPublicKey(privateKey);
  const secretKey = await solanaKeyToBytes(privateKey);
  const extensions = (paymentRequired as unknown as Record<string, unknown>).extensions as Record<string, unknown> | undefined;
  return createSolanaPaymentPayload(
    secretKey,
    fromAddress,
    details.recipient,
    details.amount,
    feePayer,
    {
      resourceUrl,
      resourceDescription: details.resource?.description || "BlockRun Solana API call",
      maxTimeoutSeconds: details.maxTimeoutSeconds || 300,
      extra: details.extra as Record<string, unknown>,
      ...(extensions ? { extensions } : {}),
    },
  );
}

/**
 * POST `body` to a paid Solana-gateway endpoint, handling the 402 → sign →
 * retry x402 dance. The Solana image/media routes settle OPTIMISTICALLY and
 * respond synchronously (generation can take 10–180s), so `paidTimeoutMs`
 * must cover the full generation, not just the HTTP round-trip.
 */
export async function solanaPaidPost(
  endpoint: string,
  body: Record<string, unknown>,
  paidTimeoutMs: number,
  opts?: PaidRequestHooks & {
    /**
     * Invoked with the quoted USD (from the 402 `details.amount`) AFTER the quote
     * is parsed but BEFORE anything is signed or paid. Throw from here to abort
     * without paying — e.g. to re-check the real price against a budget cap when
     * the Solana gateway's marked-up amount exceeds the caller's estimate.
     */
    onQuote?: (quotedUsd: number | null, details: ReturnType<typeof extractPaymentDetails>) => void;
  },
): Promise<SolanaPaidPostResult> {
  const privateKey = await requireSolanaKey();

  const apiUrl = SolanaLLMClient.SOLANA_API_URL;
  const url = `${apiUrl}${endpoint}`;

  // Step 1: unpaid request → 402 quote.
  const quoteResp = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, QUOTE_TIMEOUT_MS);

  if (quoteResp.status !== 402) {
    const data = await quoteResp.json().catch(() => ({})) as Record<string, unknown>;
    throw new Error(`Unexpected status ${quoteResp.status} (the endpoint did not return a quote): ${JSON.stringify(data)}`);
  }

  // The gateway sends the requirements both as a PAYMENT-REQUIRED header and
  // as the JSON body — fall back to the body (base64-wrapped, the shape
  // parsePaymentRequired expects) when a proxy strips the header.
  const prHeader = await readPaymentRequired(quoteResp);
  const context = parseSolanaChallenge(prHeader);

  // Hand the caller the REAL quoted price before we sign/pay, so it can re-check
  // the marked-up Solana amount against its budget cap and abort (by throwing)
  // if it would overshoot — the amount is only known now, after the quote.
  opts?.onQuote?.(context.paidUsd, context.details);
  const paymentPayload = await signSolanaChallenge(context, url, privateKey);

  // Step 2: paid request. The signed SPL transaction embeds a recent blockhash
  // (~60-90s validity); the gateway settles optimistically in parallel with
  // generation, so submitting right after signing keeps it inside the window.
  opts?.onPaidRequest?.();
  const resp = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "PAYMENT-SIGNATURE": paymentPayload },
    body: JSON.stringify(body),
  }, paidTimeoutMs);
  opts?.onPaidResponse?.();

  if (resp.status === 402) {
    await resp.json().catch(() => ({}));
    throw paidRequestRefused(settleFailureReason(resp), "on the paid request");
  }
  if (!resp.ok) {
    const errBody = await resp.json().catch(() => ({ error: "Request failed" })) as Record<string, unknown>;
    throw new Error(`API error ${resp.status}: ${JSON.stringify(errBody)}`);
  }

  // The 200 IS the settlement — the money moved before this body was read. An
  // unguarded .json() on a truncated or aborted response threw here, and the
  // caller's catch then reported a failure with nothing booked, which is the
  // one direction that must never happen. Hand back what we know instead: the
  // charge is real whether or not the payload parsed.
  const data = await resp.json().catch(() => ({
    error: "The paid response could not be parsed. The 200 means the payment settled — the charge stands.",
  })) as Record<string, unknown>;
  return { data, paidUsd: context.paidUsd };
}

/**
 * Solana x402 flow for payment-on-completion media endpoints such as video.
 * The paid POST is issued exactly once. Only idempotent poll GETs are retried;
 * their SVM transaction is periodically re-signed with a fresh blockhash
 * because one expires long before a slow Seedance 2.5 job can finish. The
 * authorized amount, recipient and fee payer stay pinned to the original 402.
 *
 * Money-path invariants (each has a test in test/solana-402-async.test.ts):
 *   - nothing is signed before onQuote has approved the authoritative price;
 *   - the budget clock starts here, not after submit, so the caller's cap is a
 *     true total; every request is clamped to what is left of it;
 *   - a poll answer carrying X-Payment-Receipt IS settlement, whatever its body;
 *   - a poll 402 is classified from PAYMENT-RESPONSE: permanent failures
 *     surface as a PaymentError (funding), everything else is the gateway's
 *     documented re-sign path, bounded by maxReactiveResigns.
 */
export async function solanaPaidAsyncPost(
  endpoint: string,
  body: Record<string, unknown>,
  opts: SolanaPaidAsyncPostOptions = {},
): Promise<SolanaPaidPostResult> {
  const startedAt = Date.now();
  const pollBudgetMs = opts.pollBudgetMs ?? SOLANA_ASYNC_DEFAULT_BUDGET_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? SOLANA_ASYNC_POLL_INTERVAL_MS;
  const submitTimeoutMs = opts.submitTimeoutMs ?? SOLANA_ASYNC_SUBMIT_TIMEOUT_MS;
  const pollTimeoutMs = opts.pollTimeoutMs ?? SOLANA_ASYNC_POLL_TIMEOUT_MS;
  const resignIntervalMs = opts.resignIntervalMs ?? SOLANA_ASYNC_RESIGN_INTERVAL_MS;
  const maxReactiveResigns = opts.maxReactiveResigns ?? SOLANA_ASYNC_MAX_REACTIVE_RESIGNS;
  const what = opts.what ?? "Video generation";
  const tool = opts.tool ?? "blockrun_video";
  const deadline = startedAt + pollBudgetMs;

  const privateKey = await requireSolanaKey();

  const apiUrl = SolanaLLMClient.SOLANA_API_URL;
  const url = `${apiUrl}${endpoint}`;
  const quoteResp = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, pollTimeoutFor(deadline, Date.now(), QUOTE_TIMEOUT_MS) || QUOTE_TIMEOUT_MS);
  if (quoteResp.status !== 402) {
    // Same as solanaPaidPost and the Base video path: a paid route that does
    // not quote is a fault, not a free render. Returning the body as a
    // completed clip with paidUsd 0 made recordActualSpend book the full
    // ESTIMATE (0 is "unknown" there) for a call that charged nothing.
    const data = await quoteResp.json().catch(() => ({})) as Record<string, unknown>;
    throw new Error(`Unexpected status ${quoteResp.status} (the endpoint did not return a quote): ${JSON.stringify(data)}`);
  }

  const paymentHeader = await readPaymentRequired(quoteResp);
  const original = parseSolanaChallenge(paymentHeader);
  if (original.paidUsd === null) {
    throw new Error(`The gateway's Solana quote carried an unreadable amount (${JSON.stringify(original.details.amount)}); refusing to sign it. No charge was made.`);
  }
  opts.onQuote?.(original.paidUsd, original.details);

  // Stamp BEFORE signing: the blockhash is fetched inside the sign call, and a
  // slow submit afterwards must not make the tracked age lag the real one.
  let nextResignAt = Date.now() + resignIntervalMs;
  let paymentPayload = await signSolanaChallenge(original, url, privateKey);

  const submitTimeout = pollTimeoutFor(deadline, Date.now(), submitTimeoutMs);
  if (submitTimeout === 0) {
    throw new Error(`Budget of ${Math.round(pollBudgetMs / 1000)}s was spent before the job could be submitted. No charge was made.`);
  }
  opts.onPaidRequest?.();
  const submitResp = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "PAYMENT-SIGNATURE": paymentPayload },
    body: JSON.stringify(body),
  }, submitTimeout);
  opts.onPaidResponse?.();
  if (submitResp.status === 402) {
    await submitResp.json().catch(() => ({}));
    throw paidRequestRefused(settleFailureReason(submitResp), "at submit");
  }

  const submitData = await submitResp.json().catch(() => ({})) as Record<string, unknown>;
  const pollPath = typeof submitData.poll_url === "string" ? submitData.poll_url : "";
  const jobId = typeof submitData.id === "string" ? submitData.id : undefined;
  // A 200 is terminal only when it is NOT an async job envelope. The Base
  // path accepts 200 as a submit status and polls; a 200 + poll_url treated
  // as a finished clip would book the charge and then fail on the missing URL.
  if (submitResp.status === 200 && !pollPath) {
    return {
      data: submitData,
      paidUsd: original.paidUsd,
      txHash: submitResp.headers.get("x-payment-receipt") || undefined,
      jobId,
    };
  }
  if (submitResp.status !== 202 && submitResp.status !== 200) {
    throw new Error(`API error ${submitResp.status}: ${JSON.stringify(submitData)}`);
  }

  if (!pollPath) throw new Error(`Submit response missing poll_url: ${JSON.stringify(submitData)}`);
  const pollUrl = new URL(pollPath, apiUrl);
  if (pollUrl.origin !== new URL(apiUrl).origin) {
    throw new Error(`Refusing to send a payment signature to an off-gateway poll URL: ${pollUrl.origin}. No charge was made.`);
  }

  // Which settlement model this route follows (see the module comment). The
  // gateway declares settled-at-submit on the wire — the header and the body
  // field are both read because a proxy can strip either — and the helper
  // never assumes it: an answer that says nothing is payment-on-completion.
  const settledAtSubmit =
    (submitResp.headers.get("x-payment-optimistic") || "").toLowerCase() === "true" ||
    submitData.payment_status === "settled_optimistic";

  // The gateway keeps a finished job claimable for ~48h; every message that
  // gives up on one must say so, because re-running the tool submits (and
  // pays for) a brand-new job.
  const reclaimNote = `The finished job stays claimable on the gateway for ~48h${jobId ? ` (job ${jobId})` : ""}; re-running ${tool} would start and charge a new job.`;
  const settledNote = `The gateway settled the payment at submit (payment_status settled_optimistic), so the charge stands${jobId ? ` (job ${jobId})` : ""}.`;
  // Every give-up after the submit goes through here so the two models cannot
  // drift apart: on a settled-at-submit route the money is gone whatever the
  // failure was, and the tool has to book it and name the job — the same
  // BilledJobError the account rail throws, for the same reason.
  const giveUp = (core: string, uncharged: string): Error =>
    settledAtSubmit
      ? new BilledJobError(`${core} ${settledNote} ${reclaimNote}`, { paidUsd: original.paidUsd, jobId, billing: "billed" })
      : new Error(`${core} ${uncharged} ${reclaimNote}`);

  let resignsLeft = maxReactiveResigns;
  let lastStatus = typeof submitData.status === "string" ? submitData.status : "queued";
  let lastSettleReason: string | undefined;
  // True between a paid poll leaving and its answer arriving. Read at the
  // deadline: a poll that was still in flight can settle server-side after
  // this client gives up; one that was answered cannot.
  let paidPollInFlight = false;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

    // Proactively refresh only the transaction/blockhash. The authorized
    // amount, recipient and fee payer remain pinned to the original 402.
    if (Date.now() >= nextResignAt) {
      const attemptedAt = Date.now();
      try {
        paymentPayload = await signSolanaChallenge(original, url, privateKey);
        nextResignAt = attemptedAt + resignIntervalMs;
      } catch {
        // Best effort: keep polling with the previous signature, retry the
        // refresh after a short back-off rather than on every iteration. A
        // 402 below obtains a fresh challenge and reports a precise failure.
        nextResignAt = Date.now() + SOLANA_ASYNC_RESIGN_RETRY_MS;
      }
    }

    // Clamp to the budget that is actually left: checking the deadline only
    // at the top of the loop bounds when a poll may START, not when it ends.
    const pollTimeout = pollTimeoutFor(deadline, Date.now(), pollTimeoutMs);
    if (pollTimeout === 0) break;

    let pollResp: Response;
    paidPollInFlight = true;
    opts.onPaidRequest?.();
    try {
      pollResp = await fetchWithTimeout(pollUrl.toString(), {
        method: "GET",
        headers: { "PAYMENT-SIGNATURE": paymentPayload },
      }, pollTimeout);
    } catch {
      // Polling is idempotent and settlement has not been observed. A transient
      // disconnect is safe to retry inside the existing deadline. The in-flight
      // flag stays set (and the caller's tracker stays armed): the request
      // that never answered may still be settling server-side.
      continue;
    }
    paidPollInFlight = false;
    opts.onPaidResponse?.();

    if (pollResp.status === 402) {
      // The gateway's settle-failure 402 carries PAYMENT-RESPONSE (the reason),
      // not a fresh challenge; the challenge comes from a separate unpaid GET.
      // Its body is informational only — consume it to release the socket.
      lastSettleReason = settleFailureReason(pollResp) ?? lastSettleReason;
      await pollResp.json().catch(() => ({}));
      if (isFundingFailure(lastSettleReason)) {
        // On a settled-at-submit route the poll never settles, so a funding
        // reason there is the delivery signature being refused — the charge
        // already stands. Everywhere else it is the wallet.
        if (settledAtSubmit) throw giveUp(`The Solana gateway refused the delivery signature (reason: ${lastSettleReason}).`, "");
        throw new PaymentError(`Payment was rejected while settling the completed job (${lastSettleReason}). Check your Solana USDC balance. ${reclaimNote}`);
      }
      if (isInvalidAuthFailure(lastSettleReason)) {
        throw giveUp(
          `The Solana gateway refused the payment signature while settling the completed job (reason: ${lastSettleReason}) — a signing/authorization fault, not a funding problem.`,
          "No charge was made.",
        );
      }
      if (resignsLeft <= 0) {
        throw giveUp(
          `Solana settlement did not go through after ${maxReactiveResigns} re-signs${lastSettleReason ? ` (last gateway reason: ${lastSettleReason})` : ""}.`,
          "The job finished upstream but this client observed no settlement receipt, so no charge was made.",
        );
      }
      resignsLeft--;
      let challenge: Response;
      try {
        challenge = await fetchWithTimeout(pollUrl.toString(), { method: "GET" }, pollTimeoutFor(deadline, Date.now(), pollTimeoutMs) || 1);
      } catch {
        // Same idempotent-retry rule as the paid poll above: a transient
        // disconnect on the challenge fetch must not abandon a job the
        // gateway has already finished.
        continue;
      }
      if (challenge.status !== 402) {
        await challenge.json().catch(() => ({}));
        continue;
      }
      const freshHeader = await readPaymentRequired(challenge);
      const fresh = parseSolanaChallenge(freshHeader);
      const originalFeePayer = (original.details.extra as { feePayer?: string } | undefined)?.feePayer;
      const freshFeePayer = (fresh.details.extra as { feePayer?: string } | undefined)?.feePayer;
      if (
        String(fresh.details.amount) !== String(original.details.amount) ||
        fresh.details.recipient !== original.details.recipient ||
        freshFeePayer !== originalFeePayer
      ) {
        throw giveUp("The refreshed poll challenge changed the payment amount, recipient or fee payer; refusing to re-authorize it.", "No charge was made.");
      }
      nextResignAt = Date.now() + resignIntervalMs;
      paymentPayload = await signSolanaChallenge(fresh, pollUrl.toString(), privateKey);
      continue;
    }

    const pollData = await pollResp.json().catch(() => ({})) as Record<string, unknown>;
    if (typeof pollData.status === "string") lastStatus = pollData.status;

    // A receipt header IS settlement — the USDC moved the moment the gateway
    // wrote it, whatever the body looks like. Return so the caller books it
    // before validating the payload (a truncated body must not erase a charge).
    const receipt = pollResp.headers.get("x-payment-receipt") || pollResp.headers.get("X-Payment-Receipt");
    if (pollResp.ok && receipt) {
      return { data: pollData, paidUsd: original.paidUsd, txHash: receipt, jobId };
    }

    if (lastStatus === "failed") {
      // Typed on both models. The gateway echoes the upstream failure text
      // verbatim, and MiniMax's is "The operation was aborted due to timeout";
      // a tool that classified this by prose booked a render the gateway had
      // just said was not charged (C13).
      const failed = `${what} failed upstream: ${String(pollData.error || "unknown")}.`;
      if (settledAtSubmit) {
        throw new BilledJobError(`${failed} ${settledNote}`, { paidUsd: original.paidUsd, jobId, billing: "billed" });
      }
      throw new JobFailedError(`${failed} No payment was taken.`, { jobId });
    }
    if (pollResp.ok && lastStatus === "completed") {
      return { data: pollData, paidUsd: original.paidUsd, txHash: undefined, jobId };
    }
    if (pollResp.status === 202 || pollResp.status === 504 || pollResp.ok) continue;
    const pollError = `${what} poll error ${pollResp.status}: ${JSON.stringify(pollData)}`;
    if (settledAtSubmit) throw giveUp(pollError, "");
    throw new Error(pollError);
  }

  // The deadline says what this helper KNOWS, and the hooks above let the
  // caller's tracker know the same thing: a poll that was still in flight can
  // settle server-side (the gateway does not stop because we hung up); a poll
  // that was answered "in_progress" cannot, because on this model settlement
  // needs a signed poll to observe "completed".
  const deadlineCore = `${what} did not complete within ${Math.round(pollBudgetMs / 1000)}s (last status: ${lastStatus}).`;
  if (settledAtSubmit) throw giveUp(deadlineCore, "");
  throw new Error(
    paidPollInFlight
      ? `${deadlineCore} No settlement receipt was observed by this client, but a poll carrying the payment signature was still in flight at the deadline and can settle server-side, so check the wallet's recent transactions before retrying. ${reclaimNote}`
      : `${deadlineCore} The last poll was answered and no request carrying the payment signature is outstanding, so no charge was made. ${reclaimNote}`,
  );
}
