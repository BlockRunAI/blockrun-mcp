// src/tools/music.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { amountToUsd, reserveBudget, recordActualSpend } from "../utils/budget.js";
import { formatError, isPaymentRejectionError } from "../utils/errors.js";
import { launchTopUp } from "../utils/onramp.js";
import { fetchWithTimeout, isTimeoutError } from "../utils/http.js";
import type { BudgetState } from "../types.js";
import { getChain, getOrCreateWalletKey } from "../utils/wallet.js";
import { privateKeyToAccount } from "viem/accounts";
import {
  createPaymentPayload,
  parsePaymentRequired,
  extractPaymentDetails,
} from "@blockrun/llm";

const BLOCKRUN_API = "https://blockrun.ai/api";
const MUSIC_COST = 0.1575;
// Async slow-path polling. MiniMax music takes 1-3 min: fast tracks complete
// inline (200), slower ones return 202 + poll_url and we poll like blockrun_video.
const MUSIC_POLL_INTERVAL_MS = 5_000;
const MUSIC_POLL_BUDGET_MS = 240_000; // 4 min overall budget for submit + polling

export function registerMusicTool(server: McpServer, budget: BudgetState): void {
  server.registerTool(
    "blockrun_music",
    {
      description: `Generate music tracks via BlockRun x402 (async, client-polled).

Generates a full-length ~3 minute MP3 track. Takes 1-3 minutes to complete. The
tool submits the job and, for slower tracks, polls until it is ready; payment
settles only when a finished track is returned — if it fails or times out, you
are not charged.

Models: minimax/music-2.5+ ($0.1575), minimax/music-2.5 ($0.1575)

Returns a permanent BlockRun-hosted URL.`,
      inputSchema: {
        prompt: z.string().describe("Music style, mood, or description. E.g. 'upbeat synthwave with neon pads', 'chill lo-fi beats', 'epic orchestral film score'"),
        instrumental: z.boolean().optional().default(true).describe("Generate without vocals (default: true)"),
        lyrics: z.string().optional().describe("Custom lyrics. Cannot be used with instrumental: true"),
        model: z.enum(["minimax/music-2.5+", "minimax/music-2.5"]).optional().default("minimax/music-2.5+").describe("Music model to use"),
        agent_id: z.string().optional().describe("Agent identifier for budget tracking and enforcement."),
      },
    },
    async ({ prompt, instrumental, lyrics, model, agent_id }) => {
      // Reserve the estimate up front so concurrent calls can't each pass a
      // stale budget; release in finally once the call settles or fails.
      let gate: ReturnType<typeof reserveBudget> | undefined;
      try {
        if (getChain() !== "base") {
          return {
            content: [{ type: "text", text: formatError("blockrun_music currently settles on Base only. Switch BlockRun to Base (for example: run blockrun_wallet with action:chain chain:base) and fund the Base wallet with USDC.") }],
            isError: true,
          };
        }

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

        const privateKey = getOrCreateWalletKey();
        const account = privateKeyToAccount(privateKey);
        const url = `${BLOCKRUN_API}/v1/audio/generations`;

        const body: Record<string, unknown> = { model, prompt, instrumental };
        if (lyrics?.trim()) body.lyrics = lyrics.trim();

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
            maxTimeoutSeconds: Math.max(details.maxTimeoutSeconds || 0, 600),
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
          const pollAbsoluteUrl = submitData.poll_url.startsWith("http")
            ? submitData.poll_url
            : `${BLOCKRUN_API.replace(/\/api$/, "")}${submitData.poll_url}`;

          const startedAt = Date.now();
          let lastStatus = submitData.status || "queued";
          while (Date.now() - startedAt < MUSIC_POLL_BUDGET_MS) {
            await new Promise((r) => setTimeout(r, MUSIC_POLL_INTERVAL_MS));

            const pollResp = await fetchWithTimeout(pollAbsoluteUrl, {
              method: "GET",
              headers: { "PAYMENT-SIGNATURE": paymentPayload },
            }, 90_000);

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

        const lines = [
          `🎵 Track ready!`,
          `URL: ${track.url}`,
          `Duration: ${track.duration_seconds ? `${track.duration_seconds}s` : "~3 min"}`,
          `Model: ${modelReturned || model}`,
          `Cost: $${billedUsd.toFixed(4)}`,
          ...(track.lyrics ? [`Lyrics: ${track.lyrics.slice(0, 200)}${track.lyrics.length > 200 ? "..." : ""}`] : []),
          ...(txHash ? [`Tx: ${txHash}`] : []),
          ``,
          `Note: The URL is a permanent BlockRun-hosted link.`,
        ];

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          structuredContent: {
            url: track.url,
            duration_seconds: track.duration_seconds,
            model: modelReturned || model,
            cost_usd: billedUsd,
            ...(track.lyrics ? { lyrics: track.lyrics } : {}),
            ...(txHash ? { txHash } : {}),
          },
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (isPaymentRejectionError(errMsg)) {
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
