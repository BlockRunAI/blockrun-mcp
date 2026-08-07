// src/tools/video.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TOOL_ANNOTATIONS } from "../tool-annotations.js";
import { z } from "zod";
import { amountToUsd, reserveBudget, recordActualSpend } from "../utils/budget.js";
import { withTxFee } from "../utils/tx-fee.js";
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
// Overall budget for the async flow (submit + client-side polling).
// Upstream jobs typically finish in 60-180s; 5 min gives comfortable margin.
const TOTAL_BUDGET_MS = 300_000;
const POLL_INTERVAL_MS = 5_000;

// Video pricing mirrors the gateway's calculateVideoPrice() + addTransactionFee()
// (blockrun/src/lib/models.ts). Two regimes:
//
//   Seedance (token360)   duration x tokens/sec x resolutionFactor x $/1M-tokens
//   Sora / Grok           duration x $/sec
//
// both then x the 5% margin, plus the flat x402 transaction fee, once.
//
// The margin and the fee are the part this table used to omit — the estimate was
// the BASE, so every video model under-reserved (verify:prices, 2026-08-07: 9/9
// short, up to $0.021 on a 30s clip). Do not store a display per-second rate
// here: /v1/models publishes those FLOORED to 3dp, which is exactly the wrong
// direction for a budget gate.
const VIDEO_MARGIN = 1.05;

// Rate card. Seedance per-1M-token rates were cut by token360 and repriced
// upstream on 2026-08-07 alongside the 2.5 launch (1.5-pro 4.32→3.108,
// 2.0-fast 11.2→7.252, 2.0 14→9.9715); the MCP table had never followed, so
// Seedance estimates were also 30-40% high on the base before the margin.
const SEEDANCE_TOKENS_PER_SECOND = 21_690; // 720p + audio baseline
const SEEDANCE_PRICE_PER_MTOKENS: Record<string, number> = {
  "bytedance/seedance-1.5-pro": 3.108,
  "bytedance/seedance-2.0-fast": 7.252,
  "bytedance/seedance-2.0": 9.9715,
  "bytedance/seedance-2.5": 13.8565,
};
const VIDEO_BASE_PRICE_PER_SECOND: Record<string, number> = {
  "xai/grok-imagine-video": 0.05,
  "azure/sora-2": 0.10,
};

// Token cost scales with output resolution; 21,690 tok/sec is the 720p figure.
// ABOVE 720p the factors are area-proportional (1080p = 2.25x, 4K = 9x). BELOW
// it they are NOT — upstream's published multipliers sit above true area (360p
// is 0.3, not 0.25), and the live 402 agrees with the table, not the geometry.
// So a new tier must be read off a real quote (`npm run verify:prices`), never
// derived. Sora/Grok bill per second and ignore this entirely.
const RESOLUTION_TOKEN_FACTOR: Record<string, number> = {
  "360p": 0.3,
  "480p": 0.5,
  "540p": 0.7,
  "720p": 1,
  "1080p": 2.25,
  "1K": 2.25,
  "4K": 9,
};

// Models that accept a BytePlus RealFace asset (real_face_asset_id).
// 2.5 is NOT on this list: RealFace is absent from its upstream parameter
// schema and it has not been probed, so we reject client-side rather than
// let the caller pay for a request token360 drops.
const REALFACE_MODELS = new Set([
  "bytedance/seedance-2.0",
  "bytedance/seedance-2.0-fast",
]);

// Models that accept first-and-last-frame interpolation (last_frame_url).
// Same reasoning as RealFace for 2.5.
const FIRST_LAST_FRAME_MODELS = new Set([
  "bytedance/seedance-1.5-pro",
  "bytedance/seedance-2.0-fast",
  "bytedance/seedance-2.0",
]);

const VIDEO_DEFAULT_DURATION: Record<string, number> = {
  "xai/grok-imagine-video": 8,
  "bytedance/seedance-1.5-pro": 5,
  "bytedance/seedance-2.0-fast": 5,
  "bytedance/seedance-2.0": 5,
  // token360 defaults 2.5's duration to -1 ("model picks"), which no prepay
  // gateway can quote — the 402 is signed BEFORE generation and binds billing to
  // a stated length. The GATEWAY is what pins it: its registry sets
  // defaultDurationSeconds 5 for 2.5, and a probe with no duration_seconds
  // quotes exactly the 5s price. This entry mirrors that so the local reserve
  // matches; the handler still omits duration_seconds when the caller does.
  "bytedance/seedance-2.5": 5,
  "azure/sora-2": 4, // Sora 2 accepts only 4 / 8 / 12s
};

// Per-model duration windows. The gateway rejects out-of-range durations with a
// 400 before quoting, so this costs nothing upstream — it just turns a round
// trip into an immediate, specific message. Source: models.ts min/max/allowed.
const VIDEO_DURATION_RANGE: Record<string, { min: number; max: number; allowed?: number[] }> = {
  "xai/grok-imagine-video": { min: 1, max: 15 },
  "bytedance/seedance-1.5-pro": { min: 4, max: 12 },
  "bytedance/seedance-2.0-fast": { min: 4, max: 15 },
  "bytedance/seedance-2.0": { min: 4, max: 15 },
  "bytedance/seedance-2.5": { min: 4, max: 30 },
  "azure/sora-2": { min: 4, max: 12, allowed: [4, 8, 12] },
};

// Which resolutions each Seedance SKU actually accepts. Mirrors the gateway's
// checkUnsupportedVideoInput (blockrun/src/lib/video-input.ts), which is the
// authority — it rejects PRE-402, so a mismatch here costs a wasted round trip
// rather than money. The asymmetry that makes it worth gating anyway: where the
// gateway DOES quote, token360 bills the tier it was asked for even if it
// renders lower, so an over-tall request pays 2.25x (1080p) or 9x (4K) for 720p.
//
// seedance-2.0 splits on generation mode — token360 400s 360p/540p/1K in
// text-to-video but accepts them when a first frame is supplied (live-probed
// upstream 2026-06-26). 4K is real 3840x2160 on 2.0 and on nothing else.
const RES_LOW = ["360p", "480p", "540p", "720p", "1080p", "1K"];
const SEEDANCE_RESOLUTIONS: Record<string, { t2v: Set<string>; i2v: Set<string>; note: string }> = {
  "bytedance/seedance-1.5-pro": { t2v: new Set(RES_LOW), i2v: new Set(RES_LOW), note: "1080p is the ceiling — only bytedance/seedance-2.0 renders true 4K" },
  "bytedance/seedance-2.0-fast": { t2v: new Set(RES_LOW), i2v: new Set(RES_LOW), note: "1080p is the ceiling — only bytedance/seedance-2.0 renders true 4K" },
  "bytedance/seedance-2.0": {
    t2v: new Set(["480p", "720p", "1080p", "4K"]),
    i2v: new Set([...RES_LOW, "4K"]),
    note: "text-to-video on 2.0 accepts 480p / 720p / 1080p / 4K only; the lower tiers need an image_url first frame",
  },
  // 2.5 trades resolution for length, and this is PROVEN, not inferred: a paid
  // probe on 2026-08-07 sent 1080p and 1K at both t2v and i2v, and token360
  // rejected all four — "the parameter resolution specified in the request is
  // not valid for model dreamina-seedance-2-5". The probe cost $0.00 because
  // nothing settles on a failed submit.
  //
  // Worth knowing why this guard earns its keep: the GATEWAY does not enforce
  // this. checkUnsupportedVideoInput's `is20` regex does not match "2.5", so 2.5
  // falls to a permissive fallback and the gateway happily quotes $3.551218 for
  // 1080p — a 402 signed for a request upstream will refuse. Without this check
  // the caller signs a payment and gets a 500 the gateway labels "temporary".
  "bytedance/seedance-2.5": { t2v: new Set(["360p", "480p", "540p", "720p"]), i2v: new Set(["360p", "480p", "540p", "720p"]), note: "2.5 caps at 720p — it trades resolution for length (up to 30s). Use bytedance/seedance-2.0 for 1080p or 4K" },
};

/**
 * What the budget gate reserves for one video job — the CHARGE, not the base.
 *
 * Exported so `npm run verify:prices` can probe it against the live 402: video
 * is the priciest call this server can issue and was the last paid estimator the
 * script did not cover, which is how a 30-40% stale Seedance table and a missing
 * margin both survived. The handler still re-reserves from the 402 before
 * paying — reference media (r2v) adds upstream input tokens nothing here can see.
 */
export function estimateVideoCost(model: string, durationSeconds?: number, resolution?: string): number {
  // THROW, never default. A model or resolution missing from the tables below
  // can only mean someone added it to the zod enum and forgot the rate — and a
  // `?? 0.05` there would price a $0.32/sec render as grok, a 6x under-reserve
  // delivered silently. Failing the call is strictly cheaper than that. Object
  // literals also resolve prototype keys ("constructor" yields a function that
  // survives `!== undefined` and makes the arithmetic NaN, which withTxFee turns
  // into a $0 reservation the budget gate always allows), so every lookup is
  // hasOwn-guarded — this is the same fail-open that once poisoned the ledger
  // via the modal GPU table (see utils/tx-fee.ts).
  const seconds = durationSeconds
    ?? (Object.hasOwn(VIDEO_DEFAULT_DURATION, model) ? VIDEO_DEFAULT_DURATION[model] : undefined)
    ?? 8;

  if (Object.hasOwn(SEEDANCE_PRICE_PER_MTOKENS, model)) {
    const res = resolution ?? "720p";
    if (!Object.hasOwn(RESOLUTION_TOKEN_FACTOR, res)) {
      throw new Error(`No token factor for resolution "${res}" — refusing to reserve at the 720p rate.`);
    }
    const tokens = seconds * SEEDANCE_TOKENS_PER_SECOND * RESOLUTION_TOKEN_FACTOR[res];
    return withTxFee((tokens * SEEDANCE_PRICE_PER_MTOKENS[model] / 1_000_000) * VIDEO_MARGIN);
  }

  if (!Object.hasOwn(VIDEO_BASE_PRICE_PER_SECOND, model)) {
    throw new Error(`No price for video model "${model}" — refusing to reserve a guessed rate.`);
  }
  return withTxFee(VIDEO_BASE_PRICE_PER_SECOND[model] * seconds * VIDEO_MARGIN);
}

export function registerVideoTool(server: McpServer, budget: BudgetState): void {
  server.registerTool(
    "blockrun_video",
    {
      description: `Generate short AI videos via BlockRun x402 (async, client-polled).

Turns a text prompt (and optional seed image) into a short MP4 clip. The tool submits the job, then polls until the video is ready (typical total wall-time 60-180s; 5 min hard cap). Payment is settled only when upstream returns a finished video — if the job fails or we give up, you are not charged.

Models. Every rate below is what you are CHARGED (margin and transaction fee included), at the 720p baseline Seedance renders by default with synced audio:
- azure/sora-2 (~$0.105/sec, 720p + synced audio, text-to-video) — OpenAI Sora 2 via Azure AI Foundry. duration_seconds must be 4, 8, or 12 (4s default -> ~$0.42/clip). No image_url / RealFace.
- xai/grok-imagine-video (~$0.053/sec, 8s default -> ~$0.42/clip, 1-15s) — stylized, fast
- bytedance/seedance-1.5-pro (~$0.071/sec, 4-12s, 5s default -> ~$0.35/clip) — cheapest Seedance, token-priced upstream
- bytedance/seedance-2.0-fast (~$0.165/sec, 4-15s, ~60-80s gen) — sweet-spot price/quality; supports BytePlus RealFace assets
- bytedance/seedance-2.0 (~$0.227/sec, 4-15s, up to 4K) — highest quality, and the ONLY model that renders true 4K; supports RealFace, first/last-frame and reference media
- bytedance/seedance-2.5 (~$0.315/sec, 4-30s, 5s default) — long-form: double 2.0's length ceiling, multilingual. NOT a strict upgrade — it caps at 720p and does NOT support RealFace or first/last-frame. Use 2.0 for 1080p/4K or real-person video.

Image-to-video is NOT cheaper than text-to-video on Seedance — same per-second rate. Higher resolutions ARE more expensive (token-priced: 1080p ~2.25x, 4K ~9x the 720p rate); the 402 quote is authoritative and is what gets charged.

RealFace: to generate video of a SPECIFIC real person, first enroll them with blockrun_realface (returns a ta_xxxx asset id), then pass real_face_asset_id here with seedance-2.0 or seedance-2.0-fast. Mutually exclusive with image_url.

Returns a permanent blockrun-hosted MP4 URL (the gateway mirrors the asset to GCS so URLs don't expire).`,
      annotations: TOOL_ANNOTATIONS.generative,
      inputSchema: {
        prompt: z.string().describe("Text description of the video to generate. E.g. 'a red apple slowly spinning on a wooden table', 'a hummingbird hovering near a red flower, ultra slow motion'"),
        image_url: z.string().url().optional().describe("Optional seed image URL for image-to-video generation"),
        real_face_asset_id: z.string().regex(/^ta_[A-Za-z0-9]+$/, "token360 asset id like 'ta_xxxx'").optional().describe("BytePlus RealFace asset id (from blockrun_realface enroll/list) to generate video of a specific real person. Seedance 2.0 / 2.0-fast only (NOT 2.5). Mutually exclusive with image_url."),
        duration_seconds: z.number().int().min(1).max(60).optional().describe("Duration to bill for. Defaults to the model's own default (8s xAI, 5s Seedance, 4s Sora). Per-model range: seedance-1.5-pro 4-12s · seedance-2.0 / 2.0-fast 4-15s · seedance-2.5 4-30s · sora-2 exactly 4, 8 or 12 · grok-imagine-video 1-15s."),
        generate_audio: z.boolean().optional().describe("Seedance only: whether to generate a synced audio track. Defaults ON for text-to-video and OFF for image/RealFace-conditioned. The auto-generated audio is occasionally rejected by upstream moderation ('output audio may contain sensitive information') even for benign prompts — pass false to skip audio and avoid that failure. Ignored by xAI/Sora."),
        resolution: z.enum(["360p", "480p", "540p", "720p", "1080p", "1K", "4K"]).optional().describe("Seedance only: output resolution. Defaults to 720p. Higher resolutions cost more (token-priced upstream, ~2.25x at 1080p and ~9x at 4K) — the final price comes from the 402 challenge, so the up-front estimate understates 1080p/4K. 4K is bytedance/seedance-2.0 only; seedance-2.5 caps at 720p. Ignored by xAI/Sora."),
        aspect_ratio: z.enum(["adaptive", "16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "9:21"]).optional().describe("Seedance only: output aspect ratio, e.g. '9:16' for vertical/mobile, '16:9' for landscape. Defaults to the model's own default. Ignored by xAI/Sora."),
        last_frame_url: z.string().url().optional().describe("Seedance 1.5-pro / 2.0 / 2.0-fast only (NOT 2.5): first-and-last-frame interpolation. A second image URL that seeds the FINAL frame so the model tweens from image_url (first frame) → last_frame_url (last frame). Requires image_url; mutually exclusive with real_face_asset_id."),
        model: z.enum(["azure/sora-2", "xai/grok-imagine-video", "bytedance/seedance-1.5-pro", "bytedance/seedance-2.0-fast", "bytedance/seedance-2.0", "bytedance/seedance-2.5"]).optional().default("xai/grok-imagine-video").describe("Video model to use"),
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
          if (!FIRST_LAST_FRAME_MODELS.has(selectedModel)) {
            return {
              content: [{ type: "text", text: formatError(`Model ${selectedModel} does not support first-and-last-frame interpolation (last_frame_url). Use bytedance/seedance-2.0, bytedance/seedance-2.0-fast or bytedance/seedance-1.5-pro.`) }],
              isError: true,
            };
          }
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

        // Resolution ceilings, per model and per generation mode. Only Seedance
        // is checked: Sora and Grok bill per second and ignore the parameter,
        // which is what the schema promises — so for them it is DROPPED from the
        // body below rather than rejected. (Forwarding it earned a gateway 400,
        // which is the opposite of "ignored".)
        const seedanceRes = SEEDANCE_RESOLUTIONS[selectedModel];
        if (resolution && seedanceRes) {
          const imageConditioned = Boolean(image_url || real_face_asset_id || last_frame_url);
          const allowed = imageConditioned ? seedanceRes.i2v : seedanceRes.t2v;
          if (!allowed.has(resolution)) {
            return {
              content: [{ type: "text", text: formatError(`${selectedModel} does not render ${resolution}${imageConditioned ? " for image-conditioned video" : ""}. ${seedanceRes.note}. Supported here: ${[...allowed].join(", ")}.`) }],
              isError: true,
            };
          }
        }

        const billedSeconds = duration_seconds ?? VIDEO_DEFAULT_DURATION[selectedModel] ?? 8;

        // Duration window — the gateway 400s these before quoting, so failing
        // here just replaces a round trip with a specific message.
        const range = VIDEO_DURATION_RANGE[selectedModel];
        if (range) {
          if (range.allowed && !range.allowed.includes(billedSeconds)) {
            return {
              content: [{ type: "text", text: formatError(`${selectedModel} accepts duration_seconds of exactly ${range.allowed.join(", ")} — got ${billedSeconds}.`) }],
              isError: true,
            };
          }
          if (billedSeconds < range.min || billedSeconds > range.max) {
            return {
              content: [{ type: "text", text: formatError(`${selectedModel} supports ${range.min}-${range.max}s — got duration_seconds=${billedSeconds}.${range.max < 30 ? " For longer clips use bytedance/seedance-2.5 (up to 30s)." : ""}`) }],
              isError: true,
            };
          }
        }

        // Image input is NOT discounted upstream on Seedance (only video-to-video
        // is), so text-to-video and image-to-video share one per-second rate.
        const estimatedCost = estimateVideoCost(selectedModel, billedSeconds, resolution);
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
        // Seedance-only, as documented. Sora/Grok bill per second, and the
        // gateway 400s a resolution it was sent for them — so honour "ignored"
        // by not sending it, instead of failing a call over a no-op parameter.
        if (resolution !== undefined && seedanceRes) body.resolution = resolution;
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

        // The 402 carries the REAL price; Seedance/Sora are token-priced, so a
        // 1080p/2K/4K render can far exceed the per-second estimate reserved at
        // the gate. Re-reserve against the cap BEFORE paying so a single high-res
        // call can't settle past the budget (and concurrent jobs hold the true
        // amount, not the low estimate, for the whole polling window).
        if (settledUsd !== null && settledUsd > estimatedCost) {
          gate?.release();
          gate = reserveBudget(budget, agent_id, settledUsd);
          if (!gate.allowed) {
            return { content: [{ type: "text", text: `${gate.reason}. Use blockrun_wallet action:"report" to see usage or action:"delegate" to increase agent budget.` }], isError: true };
          }
        }

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

        // Real settled price from the 402 (token-priced upstream); fall back to
        // the per-second estimate only if the quote didn't parse. Surfaced in the
        // footer so the user always sees the charge without the plugin's skill.
        const billedUsd = settledUsd ?? estimatedCost;
        const lines = [
          `🎬 Video ready!`,
          `URL: ${completed.url}`,
          `Duration: ${completed.duration_seconds ?? billedSeconds}s`,
          `Model: ${completed.modelReturned || selectedModel}`,
          `Cost: $${billedUsd.toFixed(4)}`,
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
            cost_usd: billedUsd,
            ...(completed.request_id ? { request_id: completed.request_id } : {}),
            ...(completed.backed_up !== undefined ? { backed_up: completed.backed_up } : {}),
            ...(completed.txHash ? { txHash: completed.txHash } : {}),
          },
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (isPaymentRejectionError(errMsg)) {
          return {
            content: [{ type: "text", text: `Video generation needs USDC — your wallet is out of funds. ${(await launchTopUp()).note}\nError: ${errMsg}` }],
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
