// src/tools/video.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { amountToUsd, reserveBudget, recordActualSpend } from "../utils/budget.js";
import { formatError, isPaymentRejectionError } from "../utils/errors.js";
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
// Overall budget for the async flow (submit + client-side polling).
// Upstream jobs typically finish in 60-180s; 5 min gives comfortable margin.
const TOTAL_BUDGET_MS = 300_000;
const POLL_INTERVAL_MS = 5_000;

// Seedance models are token-priced upstream (token360). Display fallback per-second
// rates are derived from 20,256 tokens/sec × per-1M-token rate × 1.05 margin —
// the videos route now defaults Seedance to 720p + generate_audio=true (t2v),
// roughly doubling token throughput vs. the historical 480p baseline.
// Source: blockrun/src/lib/models.ts VIDEO_MODELS.
const VIDEO_PRICE_PER_SECOND: Record<string, number> = {
  "xai/grok-imagine-video": 0.05,
  "bytedance/seedance-1.5-pro": 0.092,
  "bytedance/seedance-2.0-fast": 0.238,
  "bytedance/seedance-2.0": 0.298,
  "azure/sora-2": 0.10,
};

// Image-to-video tier (seed image or RealFace asset). Lower per-second token
// throughput than text-to-video, so cheaper. Source: blockrun models.ts.
const VIDEO_PRICE_PER_SECOND_IMAGE: Record<string, number> = {
  "bytedance/seedance-2.0-fast": 0.140,
  "bytedance/seedance-2.0": 0.183,
};

// Models that accept a BytePlus RealFace asset (real_face_asset_id).
const REALFACE_MODELS = new Set([
  "bytedance/seedance-2.0",
  "bytedance/seedance-2.0-fast",
]);

const VIDEO_DEFAULT_DURATION: Record<string, number> = {
  "xai/grok-imagine-video": 8,
  "bytedance/seedance-1.5-pro": 5,
  "bytedance/seedance-2.0-fast": 5,
  "bytedance/seedance-2.0": 5,
  "azure/sora-2": 4, // Sora 2 accepts only 4 / 8 / 12s
};

export function registerVideoTool(server: McpServer, budget: BudgetState): void {
  server.registerTool(
    "blockrun_video",
    {
      description: `Generate short AI videos via BlockRun x402 (async, client-polled).

Turns a text prompt (and optional seed image) into a short MP4 clip. The tool submits the job, then polls until the video is ready (typical total wall-time 60-180s; 5 min hard cap). Payment is settled only when upstream returns a finished video — if the job fails or we give up, you are not charged.

Models (Seedance defaults bumped to 720p + synced audio on the gateway):
- azure/sora-2 ($0.10/sec, 720p + synced audio, text-to-video) — OpenAI Sora 2 via Azure AI Foundry. duration_seconds must be 4, 8, or 12 (4s default -> ~$0.40/clip). No image_url / RealFace.
- xai/grok-imagine-video ($0.05/sec, 8s default -> $0.40/clip) — stylized, fast
- bytedance/seedance-1.5-pro (~$0.092/sec, 720p + audio t2v, 5s default up to 10s) — cheapest Seedance, token-priced upstream
- bytedance/seedance-2.0-fast (~$0.238/sec text · ~$0.140/sec image-to-video, 720p + audio, ~60-80s gen) — sweet-spot price/quality; supports BytePlus RealFace assets
- bytedance/seedance-2.0 (~$0.298/sec text · ~$0.183/sec image-to-video, 720p + audio Pro) — highest quality; supports BytePlus RealFace assets

RealFace: to generate video of a SPECIFIC real person, first enroll them with blockrun_realface (returns a ta_xxxx asset id), then pass real_face_asset_id here with a Seedance 2.0 model. Mutually exclusive with image_url.

Returns a permanent blockrun-hosted MP4 URL (the gateway mirrors the asset to GCS so URLs don't expire).`,
      inputSchema: {
        prompt: z.string().describe("Text description of the video to generate. E.g. 'a red apple slowly spinning on a wooden table', 'a hummingbird hovering near a red flower, ultra slow motion'"),
        image_url: z.string().url().optional().describe("Optional seed image URL for image-to-video generation"),
        real_face_asset_id: z.string().regex(/^ta_[A-Za-z0-9]+$/, "token360 asset id like 'ta_xxxx'").optional().describe("BytePlus RealFace asset id (from blockrun_realface enroll/list) to generate video of a specific real person. Seedance 2.0 / 2.0-fast only. Mutually exclusive with image_url."),
        duration_seconds: z.number().int().min(1).max(60).optional().describe("Duration to bill for (defaults to the model's default — 8s for xAI, 5s for Seedance; Seedance supports up to 10s)."),
        generate_audio: z.boolean().optional().describe("Seedance only: whether to generate a synced audio track. Defaults ON for text-to-video and OFF for image/RealFace-conditioned. The auto-generated audio is occasionally rejected by upstream moderation ('output audio may contain sensitive information') even for benign prompts — pass false to skip audio and avoid that failure. Ignored by xAI/Sora."),
        resolution: z.enum(["360p", "480p", "540p", "720p", "1080p", "1K", "2K", "4K"]).optional().describe("Seedance only: output resolution. Defaults to 720p. Higher resolutions cost more (token-priced upstream) — the final price is set by the 402 challenge, so the up-front estimate may understate 1080p/4K. Ignored by xAI/Sora."),
        aspect_ratio: z.enum(["adaptive", "16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "9:21"]).optional().describe("Seedance only: output aspect ratio, e.g. '9:16' for vertical/mobile, '16:9' for landscape. Defaults to the model's own default. Ignored by xAI/Sora."),
        last_frame_url: z.string().url().optional().describe("Seedance only: first-and-last-frame interpolation. A second image URL that seeds the FINAL frame so the model tweens from image_url (first frame) → last_frame_url (last frame). Requires image_url; mutually exclusive with real_face_asset_id. Priced as image-to-video."),
        model: z.enum(["azure/sora-2", "xai/grok-imagine-video", "bytedance/seedance-1.5-pro", "bytedance/seedance-2.0-fast", "bytedance/seedance-2.0"]).optional().default("xai/grok-imagine-video").describe("Video model to use"),
        agent_id: z.string().optional().describe("Agent identifier for budget tracking and enforcement."),
      },
    },
    async ({ prompt, image_url, real_face_asset_id, duration_seconds, generate_audio, resolution, aspect_ratio, last_frame_url, model, agent_id }) => {
      // Reserve the estimate up front so concurrent calls can't each pass a
      // stale budget; release in finally once the call settles or fails.
      let gate: ReturnType<typeof reserveBudget> | undefined;
      try {
        if (getChain() !== "base") {
          return {
            content: [{ type: "text", text: formatError("blockrun_video currently settles on Base only. Switch BlockRun to Base (for example: run blockrun_wallet with action:chain chain:base) and fund the Base wallet with USDC.") }],
            isError: true,
          };
        }

        const selectedModel = model || "xai/grok-imagine-video";

        // RealFace guardrails — fail fast client-side instead of round-tripping a 400.
        if (real_face_asset_id) {
          if (!REALFACE_MODELS.has(selectedModel)) {
            return {
              content: [{ type: "text", text: formatError(`Model ${selectedModel} does not support RealFace assets. Use bytedance/seedance-2.0 or bytedance/seedance-2.0-fast.`) }],
              isError: true,
            };
          }
          if (image_url) {
            return {
              content: [{ type: "text", text: formatError("Pass exactly one of real_face_asset_id or image_url — both seed the first frame.") }],
              isError: true,
            };
          }
        }

        // first-and-last-frame interpolation needs a first frame (image_url) and
        // can't be combined with a RealFace seed.
        if (last_frame_url) {
          if (!image_url) {
            return {
              content: [{ type: "text", text: formatError("last_frame_url (first-and-last-frame interpolation) requires image_url as the first frame.") }],
              isError: true,
            };
          }
          if (real_face_asset_id) {
            return {
              content: [{ type: "text", text: formatError("last_frame_url cannot be combined with real_face_asset_id.") }],
              isError: true,
            };
          }
        }

        const billedSeconds = duration_seconds ?? VIDEO_DEFAULT_DURATION[selectedModel] ?? 8;
        // Image-input (seed image or RealFace) uses the cheaper image-to-video tier.
        const hasImageInput = Boolean(image_url || real_face_asset_id);
        const perSecond = (hasImageInput ? VIDEO_PRICE_PER_SECOND_IMAGE[selectedModel] : undefined)
          ?? VIDEO_PRICE_PER_SECOND[selectedModel]
          ?? 0.05;
        const estimatedCost = perSecond * billedSeconds;
        gate = reserveBudget(budget, agent_id, estimatedCost);
        if (!gate.allowed) {
          return {
            content: [{ type: "text", text: `${gate.reason}. Use blockrun_wallet action:"report" to see usage or action:"delegate" to increase agent budget.` }],
            isError: true,
          };
        }

        const privateKey = getOrCreateWalletKey();
        const account = privateKeyToAccount(privateKey);
        const submitUrl = `${BLOCKRUN_API}/v1/videos/generations`;

        const body: Record<string, unknown> = { model: selectedModel, prompt };
        if (image_url) body.image_url = image_url;
        if (real_face_asset_id) body.real_face_asset_id = real_face_asset_id;
        if (duration_seconds !== undefined) body.duration_seconds = duration_seconds;
        if (generate_audio !== undefined) body.generate_audio = generate_audio;
        if (resolution !== undefined) body.resolution = resolution;
        if (aspect_ratio !== undefined) body.aspect_ratio = aspect_ratio;
        if (last_frame_url) body.last_frame_url = last_frame_url;

        // Step 1: get 402 with price + requirements
        const resp402 = await fetchWithTimeout(submitUrl, {
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
        // Real on-chain price from the 402 challenge (token-priced upstream, so
        // 1080p/4K can far exceed the per-second table estimate). Book THIS, not
        // the estimate, so the budget cap reflects what was actually settled.
        const settledUsd = amountToUsd(details.amount);

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
        recordActualSpend(budget, settledUsd, estimatedCost, agent_id);

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
        if (isPaymentRejectionError(errMsg)) {
          return {
            content: [{ type: "text", text: `Video generation requires payment. Run blockrun_wallet with action: "setup" for funding instructions.\nError: ${errMsg}` }],
            isError: true,
          };
        }
        if (isTimeoutError(err)) {
          return {
            content: [{ type: "text", text: `Video generation timed out. The upstream async job didn't complete in time — please try again.\nError: ${errMsg}` }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: formatError(`Video generation failed: ${errMsg}`, { altModels: "bytedance/seedance-2.0, azure/sora-2" }) }],
          isError: true,
        };
      } finally {
        gate?.release();
      }
    }
  );
}
