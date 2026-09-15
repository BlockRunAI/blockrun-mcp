// src/tools/music.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TOOL_ANNOTATIONS } from "../tool-annotations.js";
import { z } from "zod";
import { amountToUsd, assertQuoteNearEstimate, reserveBudget, recordActualSpend } from "../utils/budget.js";
import { confirmSpend } from "../utils/confirm-spend.js";
import { withTxFee } from "../utils/tx-fee.js";
import { formatError, hasLabelledServerStatus } from "../utils/errors.js";
import { launchTopUp } from "../utils/onramp.js";
import { fetchWithTimeout, isTimeoutError } from "../utils/http.js";
import { JobFailedError, pollDeadline, pollTimeoutFor } from "../utils/poll.js";
import { sendPaid, settleGiveUp, trackPaidRequest } from "../utils/in-flight.js";
import type { BudgetState } from "../types.js";
import { getApiBase, getChain, getOrCreateWalletKey, resolveGatewayUrl } from "../utils/wallet.js";
import { isApiKeyMode } from "../utils/auth.js";
import { apiKeyAsyncPost, BilledJobError } from "../utils/api-key-call.js";
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
// The paid submit on EVERY rail. The audio route races generation against a
// 60s inline window (blockrun src/app/api/v1/audio/generations/route.ts,
// inlineGenTimeoutMs) and only then answers 202 + poll_url; fast tracks come
// back 200 inline, after the GCS backup. The Solana route does the same and
// settles the SPL transfer at POST regardless of what the client does next —
// so its 30s helper default (sized for the always-202 video route) aborted
// every track slower than 30s after the money had moved, with no job id to
// reclaim it by (audit round 3, C15). One constant, shared, so the rails
// cannot drift again; music-cost.test.ts pins it against the auth window.
export const MUSIC_SUBMIT_TIMEOUT_MS = 95_000;
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
tool submits the job and, for slower tracks, polls until it is ready. On Base
and the account rail payment settles only when a finished track is returned —
if the job fails you are not charged; if this client gives up while a paid
request is still in flight the gateway may still settle, and the error text
says so. On Solana the gateway settles the payment when it ACCEPTS the job, so
a job that later fails or outlives the poll budget is still charged — the error
text says so and names the job, which stays claimable for ~48h.

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
      // Visible to the catch, which has to book money that moved without a
      // result: the account rail bills at submit, and a Base request aborted in
      // flight can still settle server-side. Every give-up also names the job.
      let jobId: string | undefined;
      let quotedUsd: number | null = null;
      // Whether a request carrying the payment is outstanding, per call. Armed
      // the moment a signed request is about to leave — the submit, which can
      // settle inline, or a poll — never around the unpaid quote; settled on
      // every answer. utils/in-flight.ts explains why the hand-rolled boolean
      // this replaces was wrong on every rail.
      const paid = trackPaidRequest();
      // Set once a request carrying the payment has left at all (formatError's
      // afterPayment: a 5xx that came back is an answer, not a verdict).
      let paidRequestSent = false;
      // The amount booked once settlement was OBSERVED. Read by the catch: an
      // error after this point is a real charge with an unusable result, and
      // the message must say the charge stands rather than "failed" (D13).
      let bookedUsd: number | null = null;
      const book = (paidUsd: number | null) => {
        recordActualSpend(budget, paidUsd, MUSIC_COST, agent_id);
        bookedUsd = paidUsd ?? MUSIC_COST;
      };
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
          // Not wrapped in sendPaid: this rail bills at SUBMIT and the helper
          // classifies every post-submit exit as a BilledJobError itself.
          // Arming here would make a not_charged terminal failure whose
          // upstream text says "timeout" read as "may have settled".
          paidRequestSent = true;
          const { data, paidUsd, txHash } = await apiKeyAsyncPost("/v1/audio/generations", body, {
            pollBudgetMs: MUSIC_POLL_BUDGET_MS,
            pollIntervalMs: MUSIC_POLL_INTERVAL_MS,
            submitTimeoutMs: MUSIC_SUBMIT_TIMEOUT_MS,
            pollTimeoutMs: MUSIC_POLL_TIMEOUT_MS,
          });
          book(paidUsd);
          const t = (data as { data?: Array<{ url: string; duration_seconds?: number; lyrics?: string }> }).data?.[0];
          if (!t?.url) throw new Error("Completed response missing track URL");
          // Estimated only when the rail gave us nothing to settle against.
          return musicResult(t, (data as { model?: string }).model || model, paidUsd ?? MUSIC_COST, txHash, paidUsd === null);
        }

        // ---- Rail 2: Solana wallet. Same reusable helper blockrun_video uses. ----
        // sol.blockrun.ai settles this route OPTIMISTICALLY at POST (the 202
        // says payment_status "settled_optimistic"); the helper reads that
        // from the wire and turns every later failure into a BilledJobError,
        // which the catch books as a certain charge.
        if (getChain() === "solana") {
          const { solanaPaidAsyncPost } = await import("../utils/solana-402.js");
          const { data, paidUsd, txHash, jobId: solJobId } = await solanaPaidAsyncPost("/v1/audio/generations", body, {
            pollBudgetMs: MUSIC_POLL_BUDGET_MS,
            submitTimeoutMs: MUSIC_SUBMIT_TIMEOUT_MS,
            // The helper's messages name their caller; without these a music
            // give-up said "Video generation did not complete" and told the
            // agent that re-running blockrun_video would charge a new job.
            what: "Music generation",
            tool: "blockrun_music",
            // The helper offers this hook and music passed nothing, so the
            // guard fired against no one and the SPL transfer was signed for
            // whatever the quote said (audit round 2).
            onQuote: (solQuotedUsd, quoteDetails) => {
              // Captured for the give-up path: on Solana the quote is only ever
              // seen inside the helper.
              quotedUsd = solQuotedUsd;
              assertQuoteNearEstimate(solQuotedUsd, MUSIC_COST, {
                what: `${model} music`,
                quotedFor: quoteDetails?.resource?.description,
                hint: `Retry on Base (blockrun_wallet action:"chain" chain:"base"), or report the quote.`,
              });
              if (solQuotedUsd !== null && solQuotedUsd > MUSIC_COST) {
                gate?.release();
                gate = reserveBudget(budget, agent_id, solQuotedUsd);
                if (!gate.allowed) throw new Error(`${gate.reason}. Use blockrun_wallet action:"report" to see usage or action:"delegate" to increase agent budget. No charge was made.`);
              }
              // Last: nothing can refuse the quote past this line and the
              // helper signs next (see video.ts for the residual window).
              paid.arm(solQuotedUsd);
            },
            // Exact edges of every signed request — submit and each poll — so
            // a deadline reached with the last poll answered books nothing and
            // one reached with a poll in flight books the quote (C32/C37).
            onPaidRequest: () => { paidRequestSent = true; paid.arm(quotedUsd); },
            onPaidResponse: () => paid.settle(),
          });
          paid.settle();
          jobId = solJobId;
          // Book before validating the payload: a malformed completed body must
          // not make a settled charge vanish from the local ledger.
          book(paidUsd);
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
        quotedUsd = amountToUsd(details.amount);

        // WHAT was quoted, before how much. 0.49.0 added this to video (both
        // rails) and image (Solana) and left the identical hand-rolled flows
        // here unguarded — so a gateway that quotes a different product, the
        // way sol.blockrun.ai quoted azure/sora-2 as Seedance at 2.7x, was
        // signed unseen. Refusing costs nothing: nothing is signed yet.
        assertQuoteNearEstimate(quotedUsd, MUSIC_COST, {
          what: `${model} music`,
          quotedFor: details.resource?.description,
          hint: `Retry on Solana (blockrun_wallet action:"chain" chain:"solana"), or report the quote.`,
        });
        // And the cap, against the REAL price rather than the estimate.
        if (quotedUsd !== null && quotedUsd > MUSIC_COST) {
          gate?.release();
          gate = reserveBudget(budget, agent_id, quotedUsd);
          if (!gate.allowed) throw new Error(`${gate.reason}. Use blockrun_wallet action:"report" to see usage or action:"delegate" to increase agent budget. No charge was made.`);
        }

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
        // Armed for the round trip: an inline 200 IS a settlement, so a submit
        // that leaves with the signature and never answers is not "no charge".
        paidRequestSent = true;
        const submitResp = await sendPaid(paid, () => fetchWithTimeout(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "PAYMENT-SIGNATURE": paymentPayload,
          },
          body: JSON.stringify(body),
        }, MUSIC_SUBMIT_TIMEOUT_MS), quotedUsd);

        if (submitResp.status === 402) {
          // The one answer that IS a funding problem. Named like the SDK's
          // class so the catch classifies it by type, not by its words.
          await submitResp.json().catch(() => ({}));
          throw Object.assign(new Error("Payment rejected. Check your wallet balance."), { name: "PaymentError" });
        }
        if (!submitResp.ok && submitResp.status !== 202) {
          const errBody = await submitResp.json().catch(() => ({ error: "Request failed" })) as Record<string, unknown>;
          throw new Error(`API error ${submitResp.status}: ${JSON.stringify(errBody)}`);
        }

        let track: { url: string; duration_seconds?: number; lyrics?: string } | undefined;
        let modelReturned: string | undefined;
        let txHash: string | null | undefined;
        let spendBooked = false;

        if (submitResp.status === 202) {
          // Async slow path: poll with the SAME payment header until completed.
          // Settlement happens on the first completed poll; failure or giving up
          // = no charge.
          const submitData = await submitResp.json() as { id?: string; poll_url?: string; status?: string };
          if (!submitData.poll_url) throw new Error(`Async submit missing poll_url: ${JSON.stringify(submitData)}`);
          // resolveGatewayUrl, not concatenation: it pins the poll to the same
          // origin that took the payment and refuses a cross-origin redirect.
          const pollAbsoluteUrl = resolveGatewayUrl(submitData.poll_url);
          jobId = submitData.id;

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

            let pollResp: Response;
            try {
              pollResp = await sendPaid(paid, () => fetchWithTimeout(pollAbsoluteUrl, {
                method: "GET",
                headers: { "PAYMENT-SIGNATURE": paymentPayload },
              }, pollTimeoutMs), quotedUsd);
            } catch {
              // Polling is idempotent and settlement has not been observed. A
              // transient disconnect is safe to retry inside the existing
              // deadline (the EIP-3009 nonce is single-use, so re-sending the
              // same header after a lost-in-flight settlement cannot settle
              // twice), and one reset must not abandon a paid job. The tracker
              // stays armed: the request that never answered may still be
              // settling server-side.
              continue;
            }

            const pollData = await pollResp.json().catch(() => ({})) as {
              status?: string;
              data?: Array<{ url: string; duration_seconds?: number; lyrics?: string }>;
              error?: string;
              model?: string;
            };
            lastStatus = pollData.status || lastStatus;

            // Settlement happens SERVER-SIDE on the first poll the gateway
            // answers "completed" — the USDC is gone the moment we observe it,
            // whatever the rest of the payload looks like. Book immediately:
            // validating first meant a malformed completed body threw, the
            // catch returned an error, and finally released the reservation —
            // a real charge the ledger never saw (the fix video.ts got in
            // 0.39.1, which music did not).
            if (lastStatus === "completed" && !spendBooked) {
              book(quotedUsd);
              spendBooked = true;
            }

            if (pollResp.status === 202 && (lastStatus === "queued" || lastStatus === "in_progress")) continue;
            // Typed: the upstream text rides along verbatim and is not a
            // verdict on the money; the gateway's contract is that a failed
            // job on this route is not charged.
            if (lastStatus === "failed") throw new JobFailedError(`Upstream generation failed: ${pollData.error || "unknown"}. No payment taken.`, { jobId });
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
          if (!track) {
            // Whether money moved depends on the tracker, which the catch
            // reads; the message here states only what was observed.
            throw new Error(`Music generation did not complete within ${Math.round(MUSIC_POLL_BUDGET_MS / 1000)}s (last status: ${lastStatus}).`);
          }
        } else {
          // Inline fast path (200): a 200 on this route IS a settlement — the
          // gateway settles on-chain before it answers. Book the charge NOW,
          // before reading the body (speech.ts does the same): a truncated body
          // or a stripped receipt header must not un-record money that moved.
          txHash = submitResp.headers.get("X-Payment-Receipt") || submitResp.headers.get("x-payment-receipt");
          book(quotedUsd);
          spendBooked = true;
          const data = await submitResp.json().catch(() => null) as { data?: Array<{ url: string; duration_seconds?: number; lyrics?: string }>; model?: string } | null;
          track = data?.data?.[0];
          modelReturned = data?.model;
          if (!track?.url) throw new Error("No track URL in response");
        }

        // Real settled price from the 402 quote; fall back to the flat estimate
        // if it didn't parse. Surfaced in the footer so the user always sees the
        // charge without relying on the plugin's announce-cost skill.
        const billedUsd = quotedUsd ?? MUSIC_COST;
        // Backstop only — every reachable path here has already booked at the
        // moment settlement was observed.
        if (!spendBooked) book(quotedUsd);

        return musicResult(track, modelReturned || model, billedUsd, txHash, false);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const reclaim = jobId ? ` The finished job stays claimable on the gateway for ~48h (job ${jobId}); re-running blockrun_music would start and charge a new job.` : "";
        // Same classification, same order, on all three rails as video.ts —
        // every step is something the code observed, never a word in the
        // message (audit round 3, C13/C32/C36/C37).
        //
        // 1. Settlement was observed and booked, then the result could not be
        //    used. The charge stands; do not run the tool again (D13).
        if (bookedUsd !== null) {
          return {
            content: [{ type: "text", text: `Music generation completed and the charge stands — $${bookedUsd.toFixed(4)} was settled${jobId ? ` for job ${jobId}` : ""} and is booked against your budget — but the result could not be used: ${errMsg}${reclaim || " Re-running blockrun_music would start and charge a new job."}\nCheck blockrun_wallet action:"report" before doing anything else.` }],
            isError: true,
          };
        }
        // 2. Billed at SUBMIT — the account rail always, and the Solana audio
        //    route (settled optimistically at POST) via the shared helper — and
        //    the failure came after. The ledger must carry it, and the one
        //    thing the caller must not do is "try again".
        if (err instanceof BilledJobError) {
          recordActualSpend(budget, err.paidUsd, MUSIC_COST, agent_id);
          const account = isApiKeyMode();
          const billedTo = account ? "the BlockRun account" : "the Solana wallet";
          const what = err.billing === "billed"
            ? `Music generation did not return a track, but the job was billed to ${billedTo} when the gateway accepted it${err.jobId ? ` (job ${err.jobId})` : ""}.`
            : `Music generation got no answer to its submit, so the job MAY have been accepted and billed to ${billedTo}.`;
          const where = account ? "https://user.blockrun.ai/dashboard/activity" : `blockrun_wallet action:"report" or the wallet's recent transactions`;
          return {
            content: [{ type: "text", text: `${what} Check ${where} before doing anything else — a new blockrun_music call starts and bills a second job.\nError: ${errMsg}` }],
            isError: true,
          };
        }
        // 3. The wallet refused to pay: a 402 on the signed request, by type.
        //    "Fund your wallet" is the wrong remedy on the account rail — there
        //    is no wallet — and apiKeyAsyncPost words its own 402, so this is
        //    never reached there (the helper throws no PaymentError).
        if (err instanceof Error && err.name === "PaymentError") {
          return {
            content: [{ type: "text", text: `Music generation needs USDC — your wallet is out of funds. ${(await launchTopUp()).note}\nError: ${errMsg}` }],
            isError: true,
          };
        }
        // 4. A request carrying the payment was outstanding and no answer was
        //    observed: an inline submit can settle (200) and the gateway
        //    settles a completed poll whether or not we are still connected.
        //    Booked and said out loud; the tracker decides, not the chain.
        const giveUp = settleGiveUp(paid, err, { budget, agentId: agent_id, estimateUsd: MUSIC_COST, what: "Music generation", note: reclaim.trim() || undefined });
        if (giveUp) return { content: [{ type: "text", text: giveUp.text }], isError: true };
        // 5. The gateway said the job failed and nothing was charged — whatever
        //    the upstream text says (MiniMax's is "aborted due to timeout").
        if (err instanceof JobFailedError) {
          return { content: [{ type: "text", text: formatError(`Music generation failed: ${errMsg}`) }], isError: true };
        }
        // 6. A labelled 5xx is an answer, not a timeout, however it reads.
        if (hasLabelledServerStatus(errMsg)) {
          return { content: [{ type: "text", text: formatError(`Music generation failed: ${errMsg}`, { afterPayment: paidRequestSent }) + reclaim }], isError: true };
        }
        // 7. A timeout with nothing outstanding: the unpaid quote probe, a
        //    signing failure, or a deadline after the last poll was answered —
        //    settlement needs a signed request the gateway answers as settled,
        //    and the last one was not.
        if (isTimeoutError(err)) {
          const base = !isApiKeyMode();
          return {
            content: [{ type: "text", text: `Music generation timed out.${base ? ` No payment was taken.${reclaim}` : ""}\nError: ${errMsg}` }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: formatError(`Music generation failed: ${errMsg}`, { afterPayment: paidRequestSent }) }],
          isError: true,
        };
      } finally {
        gate?.release();
      }
    }
  );
}
