// src/tools/music.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TOOL_ANNOTATIONS } from "../tool-annotations.js";
import { z } from "zod";
import { amountToUsd, reserveBudget, recordActualSpend } from "../utils/budget.js";
import { confirmSpend } from "../utils/confirm-spend.js";
import { withTxFee } from "../utils/tx-fee.js";
import { formatError, isPaymentRejectionError } from "../utils/errors.js";
import { launchTopUp } from "../utils/onramp.js";
import { fetchWithTimeout, isTimeoutError } from "../utils/http.js";
import { pollDeadline, pollTimeoutFor } from "../utils/poll.js";
import type { BudgetState } from "../types.js";
import { getApiBase, getChain, getOrCreateWalletKey, resolveGatewayUrl } from "../utils/wallet.js";
import { isApiKeyMode } from "../utils/auth.js";
import { apiKeyAsyncPost } from "../utils/api-key-call.js";
import { privateKeyToAccount } from "viem/accounts";
import {
  createPaymentPayload,
  parsePaymentRequired,
  extractPaymentDetails,
} from "@blockrun/llm";
// withTxFee: music.ts was never in the tx-fee sweep. Live-verified:
// audio/generations charges $0.1595 against a $0.1575 reserve — short exactly
// the gateway's $0.002 flat fee.
const MUSIC_COST = withTxFee(0.1575);
// Async slow-path polling. MiniMax music takes 1-3 min: fast tracks complete
// inline (200), slower ones return 202 + poll_url and we poll like blockrun_video.
const MUSIC_POLL_INTERVAL_MS = 5_000;
export const MUSIC_POLL_BUDGET_MS = 240_000; // 4 min polling budget, measured from submit
export const MUSIC_POLL_TIMEOUT_MS = 90_000;
// Lifetime of the signed payment authorization, in seconds, counted from the
// moment createPaymentPayload() signs. The polling budget above is measured
// from a LATER instant (after submit), so the two are not directly comparable —
// the loop below takes the earlier of the two deadlines rather than assuming
// the poll budget is the binding one.
export const MUSIC_PAYMENT_AUTH_SECONDS = 600;
// Settle-side slack: stop polling this far before validBefore so the gateway
// still has room to settle the poll we just accepted as completed.
export const MUSIC_AUTH_MARGIN_MS = 60_000;

type Track = { url: string; duration_seconds?: number; lyrics?: string };

/**
 * One result shape for all three rails.
 *
 * `estimated` is not cosmetic. On the wallet rails the cost is the amount that
 * was actually signed and settled; on the account rail there is no per-call
 * figure to read back, so the number shown is this server's own pre-call
 * estimate. Printing the two identically would be the more comfortable choice
 * and the wrong one — it invites someone to reconcile an invoice against a
 * number we invented.
 */
function musicResult(
  track: Track,
  model: string,
  billedUsd: number,
  txHash: string | null | undefined,
  estimated: boolean,
) {
  const cost = estimated
    ? `Cost: ~$${billedUsd.toFixed(4)} (estimated — billed to your BlockRun account at exact usage; see https://user.blockrun.ai/dashboard/activity)`
    : `Cost: $${billedUsd.toFixed(4)}`;
  const lines = [
    `🎵 Track ready!`,
    `URL: ${track.url}`,
    `Duration: ${track.duration_seconds ? `${track.duration_seconds}s` : "~3 min"}`,
    `Model: ${model}`,
    cost,
    ...(track.lyrics ? [`Lyrics: ${track.lyrics.slice(0, 200)}${track.lyrics.length > 200 ? "..." : ""}`] : []),
    ...(txHash ? [`Tx: ${txHash}`] : []),
    ``,
    `Note: The URL is a permanent BlockRun-hosted link.`,
  ];
  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
    structuredContent: {
      url: track.url,
      duration_seconds: track.duration_seconds,
      model,
      cost_usd: billedUsd,
      cost_is_estimate: estimated,
      ...(track.lyrics ? { lyrics: track.lyrics } : {}),
      ...(txHash ? { txHash } : {}),
    },
  };
}

export function registerMusicTool(server: McpServer, budget: BudgetState): void {
  server.registerTool(
    "blockrun_music",
    {
      description: `Generate music tracks via BlockRun x402 (async, client-polled).

Generates a full-length ~3 minute MP3 track. Takes 1-3 minutes to complete. The
tool submits the job and, for slower tracks, polls until it is ready; payment
settles only when a finished track is returned — if it fails or times out, you
are not charged.

Model: minimax/music-2.5+ ($0.1575/track, up to ~4 min)

Returns a permanent BlockRun-hosted URL.`,
      annotations: TOOL_ANNOTATIONS.generative,
      inputSchema: {
        prompt: z.string().describe("Music style, mood, or description. E.g. 'upbeat synthwave with neon pads', 'chill lo-fi beats', 'epic orchestral film score'"),
        instrumental: z.boolean().optional().default(true).describe("Generate without vocals (default: true)"),
        lyrics: z.string().optional().describe("Custom lyrics. Cannot be used with instrumental: true"),
        // music-2.5 (no plus) removed 2026-08-12: the gateway dropped it from the
        // catalogue on purpose — same price as 2.5+, but upstream rejects
        // is_instrumental on it (MiniMax error 2013), and our schema defaults
        // instrumental:true, so every default call to it would 400. Old callers
        // pinned to "minimax/music-2.5" are remapped to 2.5+ server-side anyway.
        model: z.enum(["minimax/music-2.5+"]).optional().default("minimax/music-2.5+").describe("Music model to use"),
        agent_id: z.string().optional().describe("Agent identifier for budget tracking and enforcement."),
      },
    },
    async ({ prompt, instrumental, lyrics, model, agent_id }) => {
      // Reserve the estimate up front so concurrent calls can't each pass a
      // stale budget; release in finally once the call settles or fails.
      let gate: ReturnType<typeof reserveBudget> | undefined;
      try {
        // NO CHAIN GUARD. This tool refused every Solana call until 2026-09-05
        // ("settles on Base only"), which stopped being true well before that:
        // POST https://sol.blockrun.ai/api/v1/audio/generations answers 402 with
        // a quote of 157500, i.e. the Solana gateway prices and serves it. The
        // refusal was a stale client-side belief, and its cost was sending
        // funded Solana users to switch chains for nothing.

        if (instrumental && lyrics?.trim()) {
          return {
            content: [{ type: "text", text: formatError("Cannot specify lyrics when instrumental is true") }],
            isError: true,
          };
        }

        gate = reserveBudget(budget, agent_id, MUSIC_COST);
        if (!gate.allowed) {
          return {
            content: [{ type: "text", text: `${gate.reason}. Use blockrun_wallet action:"report" to see usage or action:"delegate" to increase agent budget.` }],
            isError: true,
          };
        }
        // Human-in-the-loop (BLOCKRUN_CONFIRM_SPEND=on): ask before signing. A
        // decline returns here — nothing is sent, and the finally releases the
        // reservation. No-ops when off, sub-threshold, or unsupported by the client.
        const confirm = await confirmSpend(server, { usd: MUSIC_COST, label: `music · ${model}` });
        if (!confirm.ok) return { content: [{ type: "text", text: confirm.reason ?? "Charge cancelled." }] };

        const body: Record<string, unknown> = { model, prompt, instrumental };
        if (lyrics?.trim()) body.lyrics = lyrics.trim();

        // ---- Rail 1: account API key. No quote, no signature, no expiry. ----
        if (isApiKeyMode()) {
          const { data, txHash } = await apiKeyAsyncPost("/v1/audio/generations", body, {
            pollBudgetMs: MUSIC_POLL_BUDGET_MS,
            pollIntervalMs: MUSIC_POLL_INTERVAL_MS,
            pollTimeoutMs: MUSIC_POLL_TIMEOUT_MS,
          });
          recordActualSpend(budget, null, MUSIC_COST, agent_id);
          const t = (data as { data?: Array<{ url: string; duration_seconds?: number; lyrics?: string }> }).data?.[0];
          if (!t?.url) throw new Error("Completed response missing track URL");
          return musicResult(t, (data as { model?: string }).model || model, MUSIC_COST, txHash, true);
        }

        // ---- Rail 2: Solana wallet. Same reusable helper blockrun_video uses. ----
        if (getChain() === "solana") {
          const { solanaPaidAsyncPost } = await import("../utils/solana-402.js");
          const { data, paidUsd, txHash } = await solanaPaidAsyncPost("/v1/audio/generations", body, {
            pollBudgetMs: MUSIC_POLL_BUDGET_MS,
          });
          // Book before validating the payload: a malformed completed body must
          // not make a settled charge vanish from the local ledger.
          recordActualSpend(budget, paidUsd, MUSIC_COST, agent_id);
          const t = (data as { data?: Array<{ url: string; duration_seconds?: number; lyrics?: string }> }).data?.[0];
          if (!t?.url) throw new Error("Completed Solana response missing track URL");
          return musicResult(t, (data as { model?: string }).model || model, paidUsd ?? MUSIC_COST, txHash, false);
        }

        // ---- Rail 3: Base wallet. The original EIP-3009 402 flow. ----
        const privateKey = getOrCreateWalletKey();
        const account = privateKeyToAccount(privateKey);
        const url = `${getApiBase()}/v1/audio/generations`;

        // Step 1: get 402
        const resp402 = await fetchWithTimeout(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }, 15_000);

        if (resp402.status !== 402) {
          const data = await resp402.json().catch(() => ({})) as Record<string, unknown>;
          throw new Error(`Unexpected status ${resp402.status} (the endpoint did not return a quote): ${JSON.stringify(data)}`);
        }

        const prHeader = resp402.headers.get("payment-required") || resp402.headers.get("PAYMENT-REQUIRED");
        if (!prHeader) throw new Error("No PAYMENT-REQUIRED header in 402 response");

        const paymentRequired = parsePaymentRequired(prHeader);
        const details = extractPaymentDetails(paymentRequired);

        // validBefore is counted from HERE, so the authorization deadline has to
        // be stamped here too — not after submit, which can burn up to 95s.
        const signedAt = Date.now();
        const paymentPayload = await createPaymentPayload(
          privateKey,
          account.address,
          details.recipient,
          details.amount,
          details.network || "eip155:8453",
          {
            resourceUrl: details.resource?.url || url,
            resourceDescription: details.resource?.description || "BlockRun Music Generation",
            // Bump to 10 min so the signed authorization stays valid through the
            // whole submit (≤95s) + poll (≤240s, plus per-poll fetch) window.
            // The gateway's default (300s) expires before a slow MiniMax track
            // completes, so settlement fails for a track that actually generated
            // (mirrors blockrun_video's fix).
            maxTimeoutSeconds: Math.max(details.maxTimeoutSeconds || 0, MUSIC_PAYMENT_AUTH_SECONDS),
            extra: details.extra,
          }
        );

        // Step 2: submit with payment. Fast tracks complete inline (200); slower
        // ones (MiniMax music is 1-3 min) return 202 + poll_url — the server
        // verified the payment but does NOT settle until a completed poll.
        const submitResp = await fetchWithTimeout(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "PAYMENT-SIGNATURE": paymentPayload,
          },
          body: JSON.stringify(body),
        }, 95_000);

        if (submitResp.status === 402) {
          throw new Error("Payment rejected. Check your wallet balance.");
        }
        if (!submitResp.ok && submitResp.status !== 202) {
          const errBody = await submitResp.json().catch(() => ({ error: "Request failed" })) as Record<string, unknown>;
          throw new Error(`API error ${submitResp.status}: ${JSON.stringify(errBody)}`);
        }

        let track: { url: string; duration_seconds?: number; lyrics?: string } | undefined;
        let modelReturned: string | undefined;
        let txHash: string | null | undefined;

        if (submitResp.status === 202) {
          // Async slow path: poll with the SAME payment header until completed.
          // Settlement happens on the first completed poll; failure or giving up
          // = no charge.
          const submitData = await submitResp.json() as { id?: string; poll_url?: string; status?: string };
          if (!submitData.poll_url) throw new Error(`Async submit missing poll_url: ${JSON.stringify(submitData)}`);
          // resolveGatewayUrl, not concatenation: it pins the poll to the same
          // origin that took the payment and refuses a cross-origin redirect.
          const pollAbsoluteUrl = resolveGatewayUrl(submitData.poll_url);

          const startedAt = Date.now();
          // Two independent deadlines, and the loop must respect BOTH. The poll
          // budget is measured from here (after submit); the authorization is
          // measured from signing and dies regardless of how long submit took.
          // Take the earlier: a slow submit shortens the window rather than
          // silently pushing polls past validBefore, and a fast one leaves the
          // full MUSIC_POLL_BUDGET_MS intact for the 1-3 min MiniMax tracks.
          const deadline = pollDeadline(
            startedAt,
            MUSIC_POLL_BUDGET_MS,
            signedAt,
            MUSIC_PAYMENT_AUTH_SECONDS * 1000,
            MUSIC_AUTH_MARGIN_MS,
          );
          let lastStatus = submitData.status || "queued";
          while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, MUSIC_POLL_INTERVAL_MS));

            // Clamp the last poll to the budget that is left, so it can never
            // stay in flight past whichever deadline bound us.
            const pollTimeoutMs = pollTimeoutFor(deadline, Date.now(), MUSIC_POLL_TIMEOUT_MS);
            if (pollTimeoutMs === 0) break;

            const pollResp = await fetchWithTimeout(pollAbsoluteUrl, {
              method: "GET",
              headers: { "PAYMENT-SIGNATURE": paymentPayload },
            }, pollTimeoutMs);

            const pollData = await pollResp.json().catch(() => ({})) as {
              status?: string;
              data?: Array<{ url: string; duration_seconds?: number; lyrics?: string }>;
              error?: string;
              model?: string;
            };
            lastStatus = pollData.status || lastStatus;

            if (pollResp.status === 202 && (lastStatus === "queued" || lastStatus === "in_progress")) continue;
            if (lastStatus === "failed") throw new Error(`Upstream generation failed: ${pollData.error || "unknown"}. No payment taken.`);
            if (pollResp.ok && lastStatus === "completed") {
              const t = pollData.data?.[0];
              if (!t?.url) throw new Error("Completed poll missing track URL");
              track = t;
              modelReturned = pollData.model;
              txHash = pollResp.headers.get("X-Payment-Receipt") || pollResp.headers.get("x-payment-receipt");
              break;
            }
            if (!pollResp.ok && pollResp.status !== 202 && pollResp.status !== 504) {
              throw new Error(`Poll error ${pollResp.status}: ${JSON.stringify(pollData)}`);
            }
            // 504 on poll = transient upstream poll timeout — retry.
          }
          if (!track) throw new Error(`Music generation did not complete within ${Math.round(MUSIC_POLL_BUDGET_MS / 1000)}s (last status: ${lastStatus}). No payment was taken.`);
        } else {
          // Inline fast path (200): settled inline. Read the receipt first and
          // parse defensively — a truncated body must not un-record a charge that
          // already settled on-chain.
          txHash = submitResp.headers.get("X-Payment-Receipt") || submitResp.headers.get("x-payment-receipt");
          const data = await submitResp.json().catch(() => null) as { data?: Array<{ url: string; duration_seconds?: number; lyrics?: string }>; model?: string } | null;
          track = data?.data?.[0];
          modelReturned = data?.model;
          if (!track?.url) {
            if (txHash) recordActualSpend(budget, amountToUsd(details.amount), MUSIC_COST, agent_id);
            throw new Error("No track URL in response");
          }
        }

        // Real settled price from the 402 quote; fall back to the flat estimate
        // if it didn't parse. Surfaced in the footer so the user always sees the
        // charge without relying on the plugin's announce-cost skill.
        const billedUsd = amountToUsd(details.amount) ?? MUSIC_COST;
        recordActualSpend(budget, amountToUsd(details.amount), MUSIC_COST, agent_id);

        return musicResult(track, modelReturned || model, billedUsd, txHash, false);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        // "Fund your wallet" is the wrong remedy on the account rail — there is
        // no wallet, and launchTopUp() would try to provision one to send a card
        // onramp to. apiKeyAsyncPost already returns the correct message for a
        // 402 there (top up credit at the portal), so let it through untouched.
        if (isPaymentRejectionError(errMsg) && !isApiKeyMode()) {
          return {
            content: [{ type: "text", text: `Music generation needs USDC — your wallet is out of funds. ${(await launchTopUp()).note}\nError: ${errMsg}` }],
            isError: true,
          };
        }
        if (isTimeoutError(err)) {
          return {
            content: [{ type: "text", text: `Music generation timed out. This can happen during peak load — please try again.\nError: ${errMsg}` }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: formatError(`Music generation failed: ${errMsg}`) }],
          isError: true,
        };
      } finally {
        gate?.release();
      }
    }
  );
}
