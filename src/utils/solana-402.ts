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
  let prHeader = quoteResp.headers.get("payment-required") || quoteResp.headers.get("PAYMENT-REQUIRED");
  if (!prHeader) {
    const respBody = await quoteResp.json().catch(() => null) as Record<string, unknown> | null;
    if (respBody && (respBody.accepts || respBody.x402Version)) {
      prHeader = Buffer.from(JSON.stringify(respBody)).toString("base64");
    }
  }
  if (!prHeader) throw new PaymentError("402 response but no payment requirements found");

  const paymentRequired = parsePaymentRequired(prHeader);
  const details = extractPaymentDetails(paymentRequired, SOLANA_NETWORK);
  if (!details.network?.startsWith("solana:")) {
    throw new PaymentError(`Expected a Solana payment quote, got network: ${details.network}. The endpoint may not support Solana settlement yet.`);
  }
  const feePayer = (details.extra as { feePayer?: string } | undefined)?.feePayer;
  if (!feePayer) throw new PaymentError("Missing feePayer in the 402 quote's extra field");

  // Only sign for a resource on the gateway's own origin — a spoofed quote must
  // not relabel the payment as authorizing some other resource.
  const quotedResource = details.resource?.url;
  const resourceUrl = quotedResource && quotedResource.startsWith(apiUrl) ? quotedResource : url;

  const fromAddress = await solanaPublicKey(privateKey);
  const secretKey = await solanaKeyToBytes(privateKey);
  const extensions = (paymentRequired as unknown as Record<string, unknown>).extensions as Record<string, unknown> | undefined;

  const paymentPayload = await createSolanaPaymentPayload(
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
  return { data, paidUsd: amountToUsd(details.amount) };
}
