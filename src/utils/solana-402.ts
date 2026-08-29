// src/utils/solana-402.ts
// Manual x402 payment flow against the Solana gateway (sol.blockrun.ai) for
// paid endpoints the SolanaLLMClient doesn't expose as public methods yet:
// image generation (solanaPaidPost, synchronous optimistic settle) and video
// (solanaPaidAsyncPost, payment-on-completion polling). Music and speech are
// candidates once their Solana routes ship. Mirrors the music.ts manual-402
// pattern on Base, but signs an SPL transfer via createSolanaPaymentPayload
// instead of an EIP-3009 authorization.
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
import { pollTimeoutFor } from "./poll.js";
import { resolveSolanaKey } from "./wallet.js";
import { amountToUsd } from "./budget.js";

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
// can't answer past 60s anyway. Submit gets Base's 30s — the gateway verifies
// and enqueues in 3-20s, and a 300s hold here was silently adding five
// minutes to the "15 min hard cap" the tool description promises.
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
// presented authorization (mirrors PERMANENT_ERRORS in the gateway's
// x402-solana.ts). Anything else on a poll 402 — stale blockhash, a concurrent
// settle claim, a facilitator hiccup — is the gateway's documented "re-sign
// and re-poll" path and must not be reported as a funding problem.
const PERMANENT_SETTLE_PATTERNS = [
  "insufficient",
  "invalid signature",
  "invalid payment",
  "unauthorized",
  "forbidden",
  "invalid_payload",
  "expired",
];
function isPermanentSettleFailure(reason: string | undefined): boolean {
  if (!reason) return false;
  const lower = reason.toLowerCase();
  return PERMANENT_SETTLE_PATTERNS.some((p) => lower.includes(p));
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

export interface SolanaPaidAsyncPostOptions {
  /**
   * Total wall time allowed for quote + submit + polling, measured from the
   * call's entry. Defaults to SOLANA_ASYNC_DEFAULT_BUDGET_MS (15 minutes).
   */
  pollBudgetMs?: number;
  /** Delay between idempotent poll GETs. Defaults to SOLANA_ASYNC_POLL_INTERVAL_MS. */
  pollIntervalMs?: number;
  /** Timeout for the single paid submit POST. Defaults to SOLANA_ASYNC_SUBMIT_TIMEOUT_MS. */
  submitTimeoutMs?: number;
  /** Timeout for each poll GET (always clamped to the remaining budget). Defaults to SOLANA_ASYNC_POLL_TIMEOUT_MS. */
  pollTimeoutMs?: number;
  /** Re-sign the SVM transaction (fresh blockhash) this often. Defaults to SOLANA_ASYNC_RESIGN_INTERVAL_MS. */
  resignIntervalMs?: number;
  /** Maximum reactive re-signs after a completed poll rejects a stale signature. Defaults to SOLANA_ASYNC_MAX_REACTIVE_RESIGNS. */
  maxReactiveResigns?: number;
  /** Called after the authoritative quote is parsed and before anything is signed. */
  onQuote?: (quotedUsd: number | null) => void;
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
  if (!header) throw new PaymentError("402 response but no payment requirements found");
  return header;
}

function parseSolanaChallenge(paymentHeader: string): SolanaPaymentContext {
  const paymentRequired = parsePaymentRequired(paymentHeader);
  const details = extractPaymentDetails(paymentRequired, SOLANA_NETWORK);
  if (!details.network?.startsWith("solana:")) {
    throw new PaymentError(`Expected a Solana payment quote, got network: ${details.network}. The endpoint may not support Solana settlement yet.`);
  }
  const feePayer = (details.extra as { feePayer?: string } | undefined)?.feePayer;
  if (!feePayer) throw new PaymentError("Missing feePayer in the 402 quote's extra field");
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
  opts?: {
    /**
     * Invoked with the quoted USD (from the 402 `details.amount`) AFTER the quote
     * is parsed but BEFORE anything is signed or paid. Throw from here to abort
     * without paying — e.g. to re-check the real price against a budget cap when
     * the Solana gateway's marked-up amount exceeds the caller's estimate.
     */
    onQuote?: (quotedUsd: number | null) => void;
  },
): Promise<SolanaPaidPostResult> {
  // resolveSolanaKey, not the SDK's file-only loader: under
  // BLOCKRUN_KEYCHAIN=strict the .solana-session file is retired once its key
  // is in the OS keychain, and getChain() still reports "solana" for it.
  const privateKey = resolveSolanaKey();
  if (!privateKey) {
    throw new PaymentError('No Solana wallet found. Run blockrun_wallet with action:"setup" to provision one.');
  }

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
  opts?.onQuote?.(context.paidUsd);
  const paymentPayload = await signSolanaChallenge(context, url, privateKey);

  // Step 2: paid request. The signed SPL transaction embeds a recent blockhash
  // (~60-90s validity); the gateway settles optimistically in parallel with
  // generation, so submitting right after signing keeps it inside the window.
  const resp = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "PAYMENT-SIGNATURE": paymentPayload },
    body: JSON.stringify(body),
  }, paidTimeoutMs);

  if (resp.status === 402) {
    throw new PaymentError("Payment was rejected. Check your Solana USDC balance.");
  }
  if (!resp.ok) {
    const errBody = await resp.json().catch(() => ({ error: "Request failed" })) as Record<string, unknown>;
    throw new Error(`API error ${resp.status}: ${JSON.stringify(errBody)}`);
  }

  const data = await resp.json() as Record<string, unknown>;
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
  const deadline = startedAt + pollBudgetMs;

  // resolveSolanaKey, not the SDK's file-only loader: under
  // BLOCKRUN_KEYCHAIN=strict the .solana-session file is retired once its key
  // is in the OS keychain, and getChain() still reports "solana" for it.
  const privateKey = resolveSolanaKey();
  if (!privateKey) {
    throw new PaymentError('No Solana wallet found. Run blockrun_wallet with action:"setup" to provision one.');
  }

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
    throw new PaymentError(`The gateway's Solana quote carried an unreadable amount (${JSON.stringify(original.details.amount)}); refusing to sign it. No charge was made.`);
  }
  opts.onQuote?.(original.paidUsd);

  // Stamp BEFORE signing: the blockhash is fetched inside the sign call, and a
  // slow submit afterwards must not make the tracked age lag the real one.
  let nextResignAt = Date.now() + resignIntervalMs;
  let paymentPayload = await signSolanaChallenge(original, url, privateKey);

  const submitTimeout = pollTimeoutFor(deadline, Date.now(), submitTimeoutMs);
  if (submitTimeout === 0) {
    throw new Error(`Budget of ${Math.round(pollBudgetMs / 1000)}s was spent before the job could be submitted. No charge was made.`);
  }
  const submitResp = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "PAYMENT-SIGNATURE": paymentPayload },
    body: JSON.stringify(body),
  }, submitTimeout);
  if (submitResp.status === 402) throw new PaymentError("Payment was rejected. Check your Solana USDC balance.");

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
    throw new PaymentError(`Refusing to send a payment signature to an off-gateway poll URL: ${pollUrl.origin}. No charge was made.`);
  }

  // The gateway keeps a finished job claimable for ~48h; every message that
  // gives up on one must say so, because re-running the tool submits (and
  // pays for) a brand-new job.
  const reclaimNote = `The finished job stays claimable on the gateway for ~48h${jobId ? ` (job ${jobId})` : ""}; re-running blockrun_video would start and charge a new job.`;

  let resignsLeft = maxReactiveResigns;
  let lastStatus = typeof submitData.status === "string" ? submitData.status : "queued";
  let lastSettleReason: string | undefined;

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
    try {
      pollResp = await fetchWithTimeout(pollUrl.toString(), {
        method: "GET",
        headers: { "PAYMENT-SIGNATURE": paymentPayload },
      }, pollTimeout);
    } catch {
      // Polling is idempotent and settlement has not been observed. A transient
      // disconnect is safe to retry inside the existing deadline.
      continue;
    }

    if (pollResp.status === 402) {
      // The gateway's settle-failure 402 carries PAYMENT-RESPONSE (the reason),
      // not a fresh challenge; the challenge comes from a separate unpaid GET.
      // Its body is informational only — consume it to release the socket.
      lastSettleReason = settleFailureReason(pollResp) ?? lastSettleReason;
      await pollResp.json().catch(() => ({}));
      if (isPermanentSettleFailure(lastSettleReason)) {
        throw new PaymentError(`Payment was rejected while settling the completed Solana video (${lastSettleReason}). Check your Solana USDC balance. ${reclaimNote}`);
      }
      if (resignsLeft <= 0) {
        throw new Error(`Solana settlement did not go through after ${maxReactiveResigns} re-signs${lastSettleReason ? ` (last gateway reason: ${lastSettleReason})` : ""}. The video finished upstream but this client observed no settlement receipt, so no charge was made. ${reclaimNote}`);
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
        throw new PaymentError("The refreshed poll challenge changed the payment amount, recipient or fee payer; refusing to re-authorize it. No charge was made.");
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
      throw new Error(`Video generation failed upstream: ${String(pollData.error || "unknown")}. No payment was taken.`);
    }
    if (pollResp.ok && lastStatus === "completed") {
      return { data: pollData, paidUsd: original.paidUsd, txHash: undefined, jobId };
    }
    if (pollResp.status === 202 || pollResp.status === 504 || pollResp.ok) continue;
    throw new Error(`Video poll error ${pollResp.status}: ${JSON.stringify(pollData)}`);
  }

  throw new Error(`Video generation did not complete within ${Math.round(pollBudgetMs / 1000)}s (last status: ${lastStatus}). No settlement receipt was observed by this client; a poll still in flight at the deadline can settle server-side, so check the wallet's recent transactions before retrying. ${reclaimNote}`);
}
