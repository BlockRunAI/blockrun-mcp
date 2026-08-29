// src/utils/solana-402.ts
// Manual x402 payment flow against the Solana gateway (sol.blockrun.ai) for
// paid endpoints the SolanaLLMClient doesn't expose as public methods yet
// (image generation today; music/speech/video are candidates once their
// Solana routes ship). Mirrors the music.ts manual-402 pattern on Base, but
// signs an SPL transfer via createSolanaPaymentPayload instead of an
// EIP-3009 authorization.
import {
  SolanaLLMClient,
  PaymentError,
  parsePaymentRequired,
  extractPaymentDetails,
  createSolanaPaymentPayload,
  solanaKeyToBytes,
  solanaPublicKey,
  loadSolanaWallet,
  SOLANA_NETWORK,
} from "@blockrun/llm";
import { fetchWithTimeout } from "./http.js";
import { amountToUsd } from "./budget.js";

const QUOTE_TIMEOUT_MS = 15_000;

export interface SolanaPaidPostResult {
  data: Record<string, unknown>;
  /** Actual USD charged, from the 402 quote. Null when unparseable — callers fall back to their estimate. */
  paidUsd: number | null;
  /** Settlement receipt from the terminal response, when the gateway returns one. */
  txHash?: string;
}

export interface SolanaPaidAsyncPostOptions {
  /** Total time allowed for submit + polling. Defaults to 15 minutes. */
  pollBudgetMs?: number;
  /** Delay between idempotent poll GETs. Defaults to 5 seconds. */
  pollIntervalMs?: number;
  /** Refresh the SVM transaction before its recent blockhash goes stale. */
  resignIntervalMs?: number;
  /** Maximum reactive re-signs after a completed poll rejects a stale signature. */
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
  const privateKey = process.env.SOLANA_WALLET_KEY || loadSolanaWallet();
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
 * their SVM transaction is periodically refreshed because a recent blockhash
 * expires long before a slow Seedance 2.5 job can finish.
 */
export async function solanaPaidAsyncPost(
  endpoint: string,
  body: Record<string, unknown>,
  requestTimeoutMs: number,
  opts: SolanaPaidAsyncPostOptions = {},
): Promise<SolanaPaidPostResult> {
  const privateKey = process.env.SOLANA_WALLET_KEY || loadSolanaWallet();
  if (!privateKey) {
    throw new PaymentError('No Solana wallet found. Run blockrun_wallet with action:"setup" to provision one.');
  }

  const apiUrl = SolanaLLMClient.SOLANA_API_URL;
  const url = `${apiUrl}${endpoint}`;
  const quoteResp = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, QUOTE_TIMEOUT_MS);
  if (quoteResp.status !== 402) {
    const data = await quoteResp.json().catch(() => ({})) as Record<string, unknown>;
    if (quoteResp.ok) return { data, paidUsd: 0 };
    throw new Error(`Unexpected status ${quoteResp.status} (the endpoint did not return a quote): ${JSON.stringify(data)}`);
  }

  const paymentHeader = await readPaymentRequired(quoteResp);
  const original = parseSolanaChallenge(paymentHeader);
  if (original.paidUsd === null) {
    throw new PaymentError(`The gateway's Solana quote carried an unreadable amount (${JSON.stringify(original.details.amount)}); refusing to sign it.`);
  }
  opts.onQuote?.(original.paidUsd);
  let paymentPayload = await signSolanaChallenge(original, url, privateKey);

  const submitResp = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "PAYMENT-SIGNATURE": paymentPayload },
    body: JSON.stringify(body),
  }, requestTimeoutMs);
  if (submitResp.status === 402) throw new PaymentError("Payment was rejected. Check your Solana USDC balance.");

  const submitData = await submitResp.json().catch(() => ({})) as Record<string, unknown>;
  if (submitResp.status === 200) {
    return {
      data: submitData,
      paidUsd: original.paidUsd,
      txHash: submitResp.headers.get("x-payment-receipt") || undefined,
    };
  }
  if (submitResp.status !== 202) {
    throw new Error(`API error ${submitResp.status}: ${JSON.stringify(submitData)}`);
  }

  const pollPath = typeof submitData.poll_url === "string" ? submitData.poll_url : "";
  if (!pollPath) throw new Error(`Submit response missing id/poll_url: ${JSON.stringify(submitData)}`);
  const pollUrl = new URL(pollPath, apiUrl);
  if (pollUrl.origin !== new URL(apiUrl).origin) {
    throw new PaymentError(`Refusing to send a payment signature to an off-gateway poll URL: ${pollUrl.origin}`);
  }

  const pollBudgetMs = opts.pollBudgetMs ?? 900_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 5_000;
  const resignIntervalMs = opts.resignIntervalMs ?? 45_000;
  let resignsLeft = opts.maxReactiveResigns ?? 3;
  const deadline = Date.now() + pollBudgetMs;
  let lastStatus = typeof submitData.status === "string" ? submitData.status : "queued";
  let lastSignedAt = Date.now();

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;

    // Proactively refresh only the transaction/blockhash. The authorized
    // amount and recipient remain pinned to the original 402 challenge.
    if (Date.now() - lastSignedAt >= resignIntervalMs) {
      try {
        paymentPayload = await signSolanaChallenge(original, url, privateKey);
        lastSignedAt = Date.now();
      } catch {
        // Best effort: keep polling with the previous signature. A terminal
        // 402 below obtains a fresh challenge and reports a precise failure.
      }
    }

    let pollResp: Response;
    try {
      pollResp = await fetchWithTimeout(pollUrl.toString(), {
        method: "GET",
        headers: { "PAYMENT-SIGNATURE": paymentPayload },
      }, Math.min(requestTimeoutMs, remaining));
    } catch {
      // Polling is idempotent and settlement has not been observed. A transient
      // disconnect is safe to retry inside the existing deadline.
      continue;
    }

    if (pollResp.status === 402 && resignsLeft > 0) {
      resignsLeft--;
      const challenge = await fetchWithTimeout(pollUrl.toString(), { method: "GET" }, Math.min(requestTimeoutMs, remaining));
      if (challenge.status === 402) {
        const freshHeader = await readPaymentRequired(challenge);
        const fresh = parseSolanaChallenge(freshHeader);
        if (fresh.details.amount !== original.details.amount || fresh.details.recipient !== original.details.recipient) {
          throw new PaymentError("The refreshed poll challenge changed the payment amount or recipient; refusing to re-authorize it.");
        }
        paymentPayload = await signSolanaChallenge(fresh, pollUrl.toString(), privateKey);
        lastSignedAt = Date.now();
        continue;
      }
    }
    if (pollResp.status === 402) throw new PaymentError("Payment was rejected while settling the completed Solana video.");

    const pollData = await pollResp.json().catch(() => ({})) as Record<string, unknown>;
    if (typeof pollData.status === "string") lastStatus = pollData.status;
    if (lastStatus === "failed") {
      throw new Error(`Video generation failed upstream: ${String(pollData.error || "unknown")}. No payment was taken.`);
    }
    if (lastStatus === "completed") {
      return {
        data: pollData,
        paidUsd: original.paidUsd,
        txHash: pollResp.headers.get("x-payment-receipt") || undefined,
      };
    }
    if (pollResp.status === 202 || pollResp.status === 504 || pollResp.ok) continue;
    throw new Error(`Video poll error ${pollResp.status}: ${JSON.stringify(pollData)}`);
  }

  throw new Error(`Video generation did not complete within ${Math.round(pollBudgetMs / 1000)}s (last status: ${lastStatus}). Settlement only happens on completion, so no payment was taken.`);
}
