// src/utils/onramp.ts
//
// Card top-up via Coinbase Onramp — the MCP equivalent of Franklin's in-panel
// "Buy USDC with card", but without a local dashboard server.
//
// The gateway's POST /v1/onramp/token is FREE ($0): the x402 signature is used
// purely as wallet authentication (verified locally, funding address bound to
// the recovered signer, nothing settles). So a user with an EMPTY wallet can
// still mint a link — no chicken-and-egg charge. The gateway holds the Coinbase
// CDP key server-side and returns a one-time https://pay.coinbase.com/... URL;
// the purchased USDC settles straight into the user's self-custody Base wallet.
//
// Coinbase Onramp is Base-only (no SPL USDC), so this requires the active chain
// to be Base; on Solana we fall back to the address/QR/bridge flow in
// blockrun_wallet action:"setup".

import { fetchWithTimeout } from "./http.js";
import { openUrl } from "./qr.js";
import { getChain, getOrCreateWalletKey, getWalletInfo } from "./wallet.js";
import { privateKeyToAccount } from "viem/accounts";
import {
  createPaymentPayload,
  parsePaymentRequired,
  extractPaymentDetails,
} from "@blockrun/llm";

const ONRAMP_ENDPOINT = "https://blockrun.ai/api/v1/onramp/token";

/**
 * Mint a one-time Coinbase Onramp URL for the given Base address (which MUST be
 * the active wallet — the gateway binds the link to the signing wallet). Runs
 * the standard two-step x402 flow at a $0 price. Throws on any gateway error or
 * if the returned URL isn't a Coinbase Onramp link.
 */
export async function mintOnrampUrl(address: string): Promise<string> {
  const privateKey = getOrCreateWalletKey();
  const account = privateKeyToAccount(privateKey);
  const body = { address, network: "base", asset: "USDC" };

  // Step 1: unauthenticated POST → 402 challenge carrying the x402 requirements.
  const resp402 = await fetchWithTimeout(ONRAMP_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, 15_000);
  if (resp402.status !== 402) {
    const d = await resp402.json().catch(() => ({})) as Record<string, unknown>;
    throw new Error(`expected a 402 challenge, got ${resp402.status}: ${JSON.stringify(d)}`);
  }

  const prHeader = resp402.headers.get("payment-required") || resp402.headers.get("PAYMENT-REQUIRED");
  if (!prHeader) throw new Error("no PAYMENT-REQUIRED header in 402 response");
  const details = extractPaymentDetails(parsePaymentRequired(prHeader));

  // Sign the (free, $0) authorization — the gateway recovers the signer to prove
  // wallet ownership; nothing settles on-chain.
  const payload = await createPaymentPayload(
    privateKey,
    account.address,
    details.recipient,
    details.amount,
    details.network || "eip155:8453",
    {
      resourceUrl: details.resource?.url || ONRAMP_ENDPOINT,
      resourceDescription: details.resource?.description || "Mint a Coinbase Onramp link to fund this wallet",
      maxTimeoutSeconds: details.maxTimeoutSeconds || 300,
      extra: details.extra,
    }
  );

  // Step 2: re-POST with the signature → { url }.
  const resp = await fetchWithTimeout(ONRAMP_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", "PAYMENT-SIGNATURE": payload },
    body: JSON.stringify(body),
  }, 20_000);
  const data = await resp.json().catch(() => ({})) as { url?: string; error?: string; message?: string };
  if (!resp.ok) throw new Error(data.message || data.error || `onramp request failed: ${resp.status}`);
  if (!data.url || !data.url.startsWith("https://pay.coinbase.com/")) {
    throw new Error("gateway returned no Coinbase Onramp URL");
  }
  return data.url;
}

export interface TopUpResult {
  opened: boolean;
  url?: string;
  note: string;
}

/**
 * Full funding UX. On Base: mint a Coinbase card-onramp link and open it in the
 * browser (best-effort). On Solana (Coinbase can't onramp SPL USDC): return
 * address/QR guidance. NEVER throws — a mint/open failure degrades to a
 * manual-funding note so it's safe to call from a tool's error path.
 */
export async function launchTopUp(): Promise<TopUpResult> {
  const chain = getChain();
  const { address } = await getWalletInfo();

  if (chain !== "base") {
    return {
      opened: false,
      note: `Card top-up is Base-only. To fund on Solana, run blockrun_wallet action:"setup" for your address + QR (send USDC SPL), or switch with action:"chain" chain:"base".`,
    };
  }

  try {
    const url = await mintOnrampUrl(address);
    const opened = await openUrl(url);
    return {
      opened,
      url,
      note: `${opened ? "Opened a Coinbase card top-up page in your browser" : "Coinbase card top-up link"}: ${url}\n` +
        `Buy USDC with a card — it settles into your Base wallet ${address}. Single-use link, expires in a few minutes.`,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      opened: false,
      note: `Couldn't create a card top-up link (${msg}). Fund manually: send USDC on Base to ${address}, or run blockrun_wallet action:"setup".`,
    };
  }
}
