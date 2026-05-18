// src/tools/video.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { checkBudget, recordSpending } from "../utils/budget.js";
import { formatError } from "../utils/errors.js";
import type { BudgetState } from "../types.js";
import { getChain, getOrCreateWalletKey } from "../utils/wallet.js";
import { privateKeyToAccount } from "viem/accounts";
import {
  createPaymentPayload,
  parsePaymentRequired,
  extractPaymentDetails,
} from "@blockrun/llm";

const BLOCKRUN_API = "https://blockrun.ai/api";
// Overall budget for the async flow (submit + client-side polling).
// Upstream jobs typically finish in 60-180s; 5 min gives comfortable margin.
const TOTAL_BUDGET_MS = 300_000;
const POLL_INTERVAL_MS = 5_000;

// Seedance models are token-priced upstream (token360). Display fallback per-second
// rates are derived from 10,128 tokens/sec × per-1M-token rate × 1.05 margin.
// Source: blockrun/src/lib/models.ts VIDEO_MODELS.
const VIDEO_PRICE_PER_SECOND: Record<string, number> = {
  "xai/grok-imagine-video": 0.05,
  "bytedance/seedance-1.5-pro": 0.046,
  "bytedance/seedance-2.0-fast": 0.119,
  "bytedance/seedance-2.0": 0.149,
};

const VIDEO_DEFAULT_DURATION: Record<string, number> = {
  "xai/grok-imagine-video": 8,
  "bytedance/seedance-1.5-pro": 5,
  "bytedance/seedance-2.0-fast": 5,
  "bytedance/seedance-2.0": 5,
};

export function registerVideoTool(server: McpServer, budget: BudgetState): void {
  server.registerTool(
    "blockrun_video",
    {
      description: `Generate short AI videos via BlockRun x402 (async, client-polled).

Turns a text prompt (and optional seed image) into a short MP4 clip. The tool submits the job, then polls until the video is ready (typical total wall-time 60-180s; 5 min hard cap). Payment is settled only when upstream returns a finished video — if the job fails or we give up, you are not charged.

Models:
- xai/grok-imagine-video ($0.05/sec, 8s default -> $0.42/clip) — stylized, fast
- bytedance/seedance-1.5-pro (~$0.046/sec, 480p, 5s default up to 10s) — cheapest, token-priced upstream
- bytedance/seedance-2.0-fast (~$0.119/sec text · ~$0.07/sec image-to-video, ~60-80s gen) — sweet-spot price/quality
- bytedance/seedance-2.0 (~$0.149/sec text · ~$0.092/sec image-to-video, 480p Pro) — highest quality

Returns a permanent blockrun-hosted MP4 URL (the gateway mirrors the asset to GCS so URLs don't expire).`,
      inputSchema: {
        prompt: z.string().describe("Text description of the video to generate. E.g. 'a red apple slowly spinning on a wooden table', 'a hummingbird hovering near a red flower, ultra slow motion'"),
        image_url: z.string().url().optional().describe("Optional seed image URL for image-to-video generation"),
        duration_seconds: z.number().int().min(1).max(60).optional().describe("Duration to bill for (defaults to the model's default — 8s for xAI, 5s for Seedance; Seedance supports up to 10s)."),
        model: z.enum(["xai/grok-imagine-video", "bytedance/seedance-1.5-pro", "bytedance/seedance-2.0-fast", "bytedance/seedance-2.0"]).optional().default("xai/grok-imagine-video").describe("Video model to use"),
        agent_id: z.string().optional().describe("Agent identifier for budget tracking and enforcement."),
      },
    },
    async ({ prompt, image_url, duration_seconds, model, agent_id }) => {
      try {
        if (getChain() !== "base") {
          return {
            content: [{ type: "text", text: formatError("blockrun_video currently settles on Base only. Switch BlockRun to Base (for example: write 'base' to ~/.blockrun/.chain) and fund the Base wallet with USDC.") }],
            isError: true,
          };
        }

        const selectedModel = model || "xai/grok-imagine-video";
        const billedSeconds = duration_seconds ?? VIDEO_DEFAULT_DURATION[selectedModel] ?? 8;
        const estimatedCost = (VIDEO_PRICE_PER_SECOND[selectedModel] ?? 0.05) * billedSeconds;
        const budgetCheck = checkBudget(budget, agent_id, estimatedCost);
        if (!budgetCheck.allowed) {
          return {
            content: [{ type: "text", text: `${budgetCheck.reason}. Use blockrun_wallet action:"report" to see usage or action:"delegate" to increase agent budget.` }],
            isError: true,
          };
        }

        const privateKey = getOrCreateWalletKey();
        const account = privateKeyToAccount(privateKey);
        const submitUrl = `${BLOCKRUN_API}/v1/videos/generations`;

        const body: Record<string, unknown> = { model: selectedModel, prompt };
        if (image_url) body.image_url = image_url;
        if (duration_seconds !== undefined) body.duration_seconds = duration_seconds;

        // Step 1: get 402 with price + requirements
        const resp402 = await fetchWithTimeout(submitUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }, 15_000);

        if (resp402.status !== 402) {
          const data = await resp402.json() as Record<string, unknown>;
          throw new Error(`Expected 402, got ${resp402.status}: ${JSON.stringify(data)}`);
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
            resourceUrl: details.resource?.url || submitUrl,
            resourceDescription: details.resource?.description || "BlockRun Video Generation",
            // Bump to 10 min so the signed authorization stays valid through the
            // async polling window. Default (~5 min) is tight when upstream is slow.
            maxTimeoutSeconds: Math.max(details.maxTimeoutSeconds || 0, 600),
            extra: details.extra,
          }
        );

        // Step 2: submit job with payment — server verifies (does not settle)
        // and returns { id, poll_url, status: "queued" } in ~3-20s.
        const submitResp = await fetchWithTimeout(submitUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "PAYMENT-SIGNATURE": paymentPayload,
          },
          body: JSON.stringify(body),
        }, 30_000);

        if (submitResp.status === 402) {
          throw new Error("Payment rejected. Check your wallet balance.");
        }
        if (!submitResp.ok && submitResp.status !== 202) {
          const errBody = await submitResp.json().catch(() => ({ error: "Submit failed" })) as Record<string, unknown>;
          throw new Error(`API error ${submitResp.status}: ${JSON.stringify(errBody)}`);
        }

        const submitData = await submitResp.json() as {
          id?: string;
          status?: string;
          poll_url?: string;
          duration_seconds?: number;
          model?: string;
        };

        if (!submitData.id || !submitData.poll_url) {
          throw new Error(`Submit response missing id/poll_url: ${JSON.stringify(submitData)}`);
        }

        // Step 3: poll with the SAME payment header. Settlement happens on the
        // first completed poll; failure or caller giving up = no charge.
        const pollAbsoluteUrl = submitData.poll_url.startsWith("http")
          ? submitData.poll_url
          : `${BLOCKRUN_API.replace(/\/api$/, "")}${submitData.poll_url}`;

        const startedAt = Date.now();
        let lastStatus = submitData.status || "queued";
        let completed: {
          url: string;
          source_url?: string;
          duration_seconds?: number;
          request_id?: string;
          backed_up?: boolean;
          modelReturned?: string;
          txHash?: string;
        } | null = null;

        while (Date.now() - startedAt < TOTAL_BUDGET_MS) {
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

          const pollResp = await fetchWithTimeout(pollAbsoluteUrl, {
            method: "GET",
            headers: { "PAYMENT-SIGNATURE": paymentPayload },
          }, 90_000);

          const pollData = await pollResp.json().catch(() => ({})) as {
            status?: string;
            data?: Array<{
              url: string;
              source_url?: string;
              duration_seconds?: number;
              request_id?: string;
              backed_up?: boolean;
            }>;
            error?: string;
            model?: string;
          };

          lastStatus = pollData.status || lastStatus;

          if (pollResp.status === 202 && (lastStatus === "queued" || lastStatus === "in_progress")) {
            continue;
          }

          if (lastStatus === "failed") {
            throw new Error(`Upstream generation failed: ${pollData.error || "unknown"}. No payment taken.`);
          }

          if (pollResp.ok && lastStatus === "completed") {
            const clip = pollData.data?.[0];
            if (!clip?.url) throw new Error("Completed poll missing video URL");
            completed = {
              url: clip.url,
              source_url: clip.source_url,
              duration_seconds: clip.duration_seconds,
              request_id: clip.request_id,
              backed_up: clip.backed_up,
              modelReturned: pollData.model,
              txHash: pollResp.headers.get("X-Payment-Receipt") ||
                pollResp.headers.get("x-payment-receipt") || undefined,
            };
            break;
          }

          if (!pollResp.ok && pollResp.status !== 202 && pollResp.status !== 504) {
            throw new Error(`Poll error ${pollResp.status}: ${JSON.stringify(pollData)}`);
          }
          // 504 on poll = upstream poll timeout, transient — retry.
        }

        if (!completed) {
          throw new Error(`Video generation did not complete within ${Math.round(TOTAL_BUDGET_MS / 1000)}s (last status: ${lastStatus}). No payment was taken.`);
        }

        const lines = [
          `🎬 Video ready!`,
          `URL: ${completed.url}`,
          `Duration: ${completed.duration_seconds ? `${completed.duration_seconds}s` : "8s"}`,
          `Model: ${completed.modelReturned || selectedModel}`,
          ...(completed.backed_up ? [`Backed up to BlockRun storage (URL is permanent)`] : completed.source_url ? [`Source URL: ${completed.source_url}`] : []),
          ...(completed.request_id ? [`Request ID: ${completed.request_id}`] : []),
          ...(completed.txHash ? [`Tx: ${completed.txHash}`] : []),
        ];
        recordSpending(budget, estimatedCost, agent_id);

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          structuredContent: {
            url: completed.url,
            ...(completed.source_url ? { source_url: completed.source_url } : {}),
            duration_seconds: completed.duration_seconds,
            model: completed.modelReturned || selectedModel,
            ...(completed.request_id ? { request_id: completed.request_id } : {}),
            ...(completed.backed_up !== undefined ? { backed_up: completed.backed_up } : {}),
            ...(completed.txHash ? { txHash: completed.txHash } : {}),
          },
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.includes("balance") || errMsg.includes("payment") || errMsg.includes("402") || errMsg.includes("rejected")) {
          return {
            content: [{ type: "text", text: `Video generation requires payment. Run blockrun_wallet with action: "setup" for funding instructions.\nError: ${errMsg}` }],
            isError: true,
          };
        }
        if (errMsg.includes("abort") || errMsg.includes("timeout") || errMsg.includes("Timeout") || errMsg.includes("timed out") || errMsg.includes("did not complete within")) {
          return {
            content: [{ type: "text", text: `Video generation timed out. The upstream async job didn't complete in time — please try again.\nError: ${errMsg}` }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: formatError(`Video generation failed: ${errMsg}`) }],
          isError: true,
        };
      }
    }
  );
}

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}
