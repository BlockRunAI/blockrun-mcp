// src/tools/video.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TOOL_ANNOTATIONS } from "../tool-annotations.js";
import { z } from "zod";
import { amountToUsd, reserveBudget, recordActualSpend } from "../utils/budget.js";
import { withTxFee } from "../utils/tx-fee.js";
import { formatError, isPaymentRejectionError } from "../utils/errors.js";
import { launchTopUp } from "../utils/onramp.js";
import { fetchWithTimeout, isTimeoutError } from "../utils/http.js";
import { pollTimeoutFor } from "../utils/poll.js";
import type { BudgetState } from "../types.js";
import { getChain, getOrCreateWalletKey } from "../utils/wallet.js";
import { isBlockedFetchHostResolved } from "../utils/ssrf.js";
import { privateKeyToAccount } from "viem/accounts";
import {
  createPaymentPayload,
  parsePaymentRequired,
  extractPaymentDetails,
} from "@blockrun/llm";

const BLOCKRUN_API = "https://blockrun.ai/api";
// Overall budget for the async flow (submit + client-side polling).
// Seedance 2.5 30s jobs can take 5-8 minutes in production.
//
// These four constants are one invariant, not four independent knobs. The
// signed EIP-3009 authorization dies at startedAt + VIDEO_PAYMENT_AUTH_SECONDS,
// and settlement happens server-side on the poll that answers "completed" — so
// a poll still IN FLIGHT past validBefore fails settlement for a video that
// actually generated (see the blockrun_music entry in CHANGELOG for the same
// bug). The loop below therefore clamps its last poll to the remaining budget,
// which keeps worst-case wall time at exactly VIDEO_TOTAL_BUDGET_MS:
//
//   VIDEO_TOTAL_BUDGET_MS + 60s margin <= VIDEO_PAYMENT_AUTH_SECONDS
//
// Without that clamp the true worst case is budget + interval + poll timeout,
// which at 540s/5s/90s lands 35s PAST a 600s authorization.
export const VIDEO_TOTAL_BUDGET_MS = 540_000;
const POLL_INTERVAL_MS = 5_000;
export const VIDEO_POLL_TIMEOUT_MS = 90_000;
// Lifetime of the signed payment authorization, in seconds. Exported so the
// margin above is asserted against the value the request actually sends,
// rather than a literal restated in the test.
export const VIDEO_PAYMENT_AUTH_SECONDS = 600;

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
  // 2.0-mini added 2026-08-12 (gateway registry, probed upstream 2026-08-11):
  // $3.5/M for BOTH text- and image-to-video — the ~40% v2v discount BytePlus
  // lists does not apply to any path we expose, so one rate is correct.
  "bytedance/seedance-2.0-mini": 3.5,
  "bytedance/seedance-2.0-fast": 7.252,
  "bytedance/seedance-2.0": 9.9715,
  "bytedance/seedance-2.5": 13.8565,
};
// Sora: duration x rate x margin. Grok is NOT in this table — it stopped
// carrying the margin (see GROK_PRICE_PER_SECOND) and it now prices per
// resolution, so it no longer shares a formula with Sora.
const VIDEO_BASE_PRICE_PER_SECOND: Record<string, number> = {
  "azure/sora-2": 0.10,
};

// xai/grok-imagine-video, probed live 2026-08-13 (unpaid 402s):
//
//   480p (the default)  8s -> $0.401   15s -> $0.751
//   720p                8s -> $0.561   15s -> $1.051
//   1080p / 4K             -> rejected upstream, no quote
//
// Two things changed under us. Grok now HONOURS `resolution` and prices it
// (this client dropped the parameter for every per-second model, so a caller
// asking for 720p silently got 480p), and it no longer carries VIDEO_MARGIN:
// 0.05 x 15 + 0.001 = $0.751 to the micro, where the margin would make it
// $0.7885. Forwarding the parameter without splitting the rate would have
// under-reserved 720p by 1.33x — the parameter and the price had to move
// together, which is why this is one change and not two.
const GROK_VIDEO_MODEL = "xai/grok-imagine-video";
const GROK_PRICE_PER_SECOND: Record<string, number> = {
  "480p": 0.05,
  "720p": 0.07,
};

// Token cost scales with output resolution; 21,690 tok/sec is the 720p figure.
// ABOVE 720p the factors are area-proportional (1080p = 2.25x, 4K = 9x). BELOW
// it they are NOT — upstream's published multipliers sit above true area (360p
// is 0.3, not 0.25), and the live 402 agrees with the table, not the geometry.
// So a new tier must be read off a real quote (`npm run verify:prices`), never
// derived. Sora/Grok bill per second and ignore this entirely.
// 360p/540p/1K trimmed 2026-08-07: token360's schema lists them for no model,
// so they left the enum too; estimateVideoCost throws on anything missing here.
const RESOLUTION_TOKEN_FACTOR: Record<string, number> = {
  "480p": 0.5,
  "720p": 1,
  "1080p": 2.25,
  "4K": 9,
};

// Models that accept a BytePlus RealFace asset (real_face_asset_id).
// 2.5 is NOT on this list: RealFace is absent from its upstream parameter
// schema and it has not been probed, so we reject client-side rather than
// let the caller pay for a request token360 drops.
const REALFACE_MODELS = new Set([
  "bytedance/seedance-2.0",
  "bytedance/seedance-2.0-fast",
  "bytedance/seedance-2.0-mini", // supportsRealFace in the gateway registry (2026-08-11 probe)
]);

// Models that accept first-and-last-frame interpolation (last_frame_url).
// Same reasoning as RealFace for 2.5.
const FIRST_LAST_FRAME_MODELS = new Set([
  "bytedance/seedance-1.5-pro",
  "bytedance/seedance-2.0-fast",
  "bytedance/seedance-2.0",
  "bytedance/seedance-2.0-mini",
]);

const VIDEO_DEFAULT_DURATION: Record<string, number> = {
  "xai/grok-imagine-video": 8,
  "bytedance/seedance-1.5-pro": 5,
  "bytedance/seedance-2.0-fast": 5,
  "bytedance/seedance-2.0": 5,
  // mini does NOT inherit 2.5's -1 default: an explicit duration survives
  // upstream (probed 2026-08-11 — 15s requested resolved to 15).
  "bytedance/seedance-2.0-mini": 5,
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
  "bytedance/seedance-2.0-mini": { min: 4, max: 15 },
  "bytedance/seedance-2.0-fast": { min: 4, max: 15 },
  "bytedance/seedance-2.0": { min: 4, max: 15 },
  "bytedance/seedance-2.5": { min: 4, max: 30 },
  "azure/sora-2": { min: 4, max: 12, allowed: [4, 8, 12] },
};

// Which resolutions each Seedance SKU actually accepts — token360's OWN
// published parameter schema (GET /v1/models/{id} -> parameter_schema), verified
// live 2026-08-07. The gateway's checkUnsupportedVideoInput will derive from
// the same source once blockrun PR #353 lands (machine-written snapshot);
// until it deploys, production still runs the OLD wide tables and this client
// is the only gate. THIS table is a hand-copy of that probe run — re-check it
// whenever the gateway resyncs its snapshot.
// The verify:prices matrix probes each model at its ceiling tier, so a gateway
// that starts quoting (or stops quoting) a tier this table disagrees with
// shows up in the free 402 sweep.
//
// No t2v/i2v split: the schema is per-model, and probing shows everything it
// lists passes in both modes, while 540p/1K hard-reject upstream even
// image-conditioned. We allow exactly the schema, nothing more — a few
// off-schema values PASS submit validation (2.0-fast 1080p, 1.5-pro 540p) but
// "passes validation" is not "renders": 1.5-pro historically echoed 2K/4K,
// billed the requested tier, and rendered 720p. Off-schema acceptance can
// silently downscale while billing the higher tier, so it stays out.
export const SEEDANCE_RESOLUTIONS: Record<string, { resolutions: Set<string>; note: string }> = {
  "bytedance/seedance-1.5-pro": {
    resolutions: new Set(["480p", "720p", "1080p"]),
    note: "1080p is the ceiling — only bytedance/seedance-2.0 renders true 4K",
  },
  "bytedance/seedance-2.0-fast": {
    resolutions: new Set(["480p", "720p"]),
    note: "720p is the ceiling on 2.0-fast — for 1080p use bytedance/seedance-1.5-pro (cheapest) or bytedance/seedance-2.0 (also 4K)",
  },
  "bytedance/seedance-2.0-mini": {
    resolutions: new Set(["480p", "720p"]),
    note: "720p is the ceiling on 2.0-mini — for 1080p use bytedance/seedance-1.5-pro (cheapest) or bytedance/seedance-2.0 (also 4K)",
  },
  "bytedance/seedance-2.0": {
    resolutions: new Set(["480p", "720p", "1080p", "4K"]),
    note: "the only model that renders true 4K (3840x2160)",
  },
  "bytedance/seedance-2.5": {
    resolutions: new Set(["480p", "720p"]),
    note: "2.5 caps at 720p — it trades resolution for length (up to 30s). Use bytedance/seedance-2.0 for 1080p or 4K",
  },
};

/**
 * Grok's own supported set, kept in the same shape as SEEDANCE_RESOLUTIONS so the
 * handler's ceiling check works for both. 1080p and 4K are refused here because
 * the gateway refuses them too (no 402 at all on a live probe) — better an
 * immediate, specific message than a round trip that returns nothing useful.
 */
const GROK_RESOLUTIONS: Record<string, { resolutions: Set<string>; note: string }> = {
  [GROK_VIDEO_MODEL]: {
    resolutions: new Set(["480p", "720p"]),
    note: "grok-imagine-video renders 480p (default, ~$0.05/sec) or 720p (~$0.07/sec) — for 1080p or 4K use a Seedance model",
  },
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

  if (model === GROK_VIDEO_MODEL) {
    // Defaults to 480p — the tier the gateway renders when no resolution is
    // sent, confirmed by the default quote matching the explicit 480p one.
    const res = resolution ?? "480p";
    if (!Object.hasOwn(GROK_PRICE_PER_SECOND, res)) {
      throw new Error(`grok-imagine-video does not render "${res}" — refusing to reserve at the 480p rate.`);
    }
    return withTxFee(GROK_PRICE_PER_SECOND[res] * seconds); // no margin, see above
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

Turns a text prompt (and optional seed image) into a short MP4 clip. The tool submits the job, then polls until the video is ready (typical total wall-time 60-180s; 9 min hard cap). Payment is settled only when upstream returns a finished video — if the job fails or we give up, you are not charged.

Models. Every rate below is what you are CHARGED (margin and transaction fee included), at the 720p baseline Seedance renders by default with synced audio:
- azure/sora-2 (~$0.105/sec, 720p + synced audio, text-to-video) — OpenAI Sora 2 via Azure AI Foundry. duration_seconds must be 4, 8, or 12 (4s default -> ~$0.42/clip). No image_url / RealFace.
- xai/grok-imagine-video ($0.05/sec at 480p default, $0.07/sec at 720p; 8s default -> $0.401/clip, 1-15s) — stylized, fast. 480p/720p only.
- bytedance/seedance-1.5-pro (~$0.071/sec, 4-12s, 5s default -> ~$0.35/clip) — cheapest Seedance, token-priced upstream
- bytedance/seedance-2.0-mini (~$0.080/sec, 4-15s, 5s default) — 2.0-generation quality at roughly half the 2.0-fast rate; 720p ceiling; supports RealFace and first/last-frame
- bytedance/seedance-2.0-fast (~$0.165/sec, 4-15s, ~60-80s gen) — sweet-spot price/quality; supports BytePlus RealFace assets
- bytedance/seedance-2.0 (~$0.227/sec, 4-15s, up to 4K) — highest quality, and the ONLY model that renders true 4K; supports RealFace, first/last-frame and reference media
- bytedance/seedance-2.5 (~$0.315/sec, 4-30s, 5s default) — long-form: double 2.0's length ceiling, multilingual. NOT a strict upgrade — it caps at 720p and does NOT support RealFace or first/last-frame. Use 2.0 for 1080p/4K or real-person video.

Image-to-video is NOT cheaper than text-to-video on Seedance — same per-second rate. Higher resolutions ARE more expensive (token-priced: 1080p ~2.25x, 4K ~9x the 720p rate); the 402 quote is authoritative and is what gets charged.

RealFace: to generate video of a SPECIFIC real person, first enroll them with blockrun_realface (returns a ta_xxxx asset id), then pass real_face_asset_id here with seedance-2.0, seedance-2.0-fast, or seedance-2.0-mini. Mutually exclusive with image_url.

Returns a permanent blockrun-hosted MP4 URL (the gateway mirrors the asset to GCS so URLs don't expire).`,
      annotations: TOOL_ANNOTATIONS.generative,
      inputSchema: {
        prompt: z.string().describe("Text description of the video to generate. E.g. 'a red apple slowly spinning on a wooden table', 'a hummingbird hovering near a red flower, ultra slow motion'"),
        image_url: z.string().url().optional().describe("Optional seed image URL for image-to-video generation"),
        real_face_asset_id: z.string().regex(/^ta_[A-Za-z0-9]+$/, "token360 asset id like 'ta_xxxx'").optional().describe("BytePlus RealFace asset id (from blockrun_realface enroll/list) to generate video of a specific real person. Seedance 2.0 / 2.0-fast / 2.0-mini only (NOT 2.5). Mutually exclusive with image_url."),
        duration_seconds: z.number().int().min(1).max(60).optional().describe("Duration to bill for. Defaults to the model's own default (8s xAI, 5s Seedance, 4s Sora). Per-model range: seedance-1.5-pro 4-12s · seedance-2.0 / 2.0-fast / 2.0-mini 4-15s · seedance-2.5 4-30s · sora-2 exactly 4, 8 or 12 · grok-imagine-video 1-15s."),
        generate_audio: z.boolean().optional().describe("Seedance only: whether to generate a synced audio track. Defaults ON for text-to-video and OFF for image/RealFace-conditioned. The auto-generated audio is occasionally rejected by upstream moderation ('output audio may contain sensitive information') even for benign prompts — pass false to skip audio and avoid that failure. Ignored by xAI/Sora."),
        resolution: z.enum(["480p", "720p", "1080p", "4K"]).optional().describe("Output resolution. Seedance defaults to 720p and is token-priced (~2.25x at 1080p, ~9x at 4K); per-model sets from token360's published schema: seedance-2.0 480p/720p/1080p/4K · 1.5-pro 480p/720p/1080p · 2.0-fast, 2.0-mini and 2.5 480p/720p only. grok-imagine-video honours 480p (default, $0.05/sec) and 720p ($0.07/sec) and rejects anything higher. Ignored by Sora only (dropped from the request)."),
        aspect_ratio: z.enum(["adaptive", "16:9", "9:16", "1:1", "4:3", "3:4", "21:9"]).optional().describe("Output aspect ratio. Seedance honors the full set; Sora uses it only to pick portrait vs landscape (9:16 / 3:4 -> portrait); Grok ignores it (the gateway never forwards it to xAI). Defaults to the model's own default. (9:21 removed 2026-08-07 — no Seedance model offers it; use 9:16 for vertical.)"),
        last_frame_url: z.string().url().optional().describe("Seedance 1.5-pro / 2.0 / 2.0-fast / 2.0-mini only (NOT 2.5): first-and-last-frame interpolation. A second image URL that seeds the FINAL frame so the model tweens from image_url (first frame) → last_frame_url (last frame). Requires image_url; mutually exclusive with real_face_asset_id."),
        model: z.enum(["azure/sora-2", "xai/grok-imagine-video", "bytedance/seedance-1.5-pro", "bytedance/seedance-2.0-mini", "bytedance/seedance-2.0-fast", "bytedance/seedance-2.0", "bytedance/seedance-2.5"]).optional().default("xai/grok-imagine-video").describe("Video model to use"),
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
              content: [{ type: "text", text: formatError(`Model ${selectedModel} does not support RealFace assets. Use bytedance/seedance-2.0, bytedance/seedance-2.0-fast or bytedance/seedance-2.0-mini.`) }],
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
              content: [{ type: "text", text: formatError(`Model ${selectedModel} does not support first-and-last-frame interpolation (last_frame_url). Use bytedance/seedance-2.0, bytedance/seedance-2.0-fast, bytedance/seedance-2.0-mini or bytedance/seedance-1.5-pro.`) }],
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

        // SSRF guard on caller-supplied URLs, mirroring blockrun_image
        // (src/tools/image.ts). This process never fetches these URLs — the
        // GATEWAY's fetcher does — so this is defense-in-depth plus a saved
        // round trip: a URL pointing at localhost / the metadata endpoint /
        // the private network was previously forwarded, quoted, and PAID for
        // before failing (or worse, succeeding) server-side. Resolved, not
        // literal: wildcard-DNS names like 127.0.0.1.nip.io are public strings
        // that map to private addresses. zod's .url() accepts any scheme, so
        // file:// etc. are rejected here too.
        for (const [name, value] of [["image_url", image_url], ["last_frame_url", last_frame_url]] as const) {
          if (!value) continue;
          const parsed = new URL(value);
          if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            return {
              content: [{ type: "text", text: formatError(`${name} must be an http(s) URL — got scheme "${parsed.protocol}"`) }],
              isError: true,
            };
          }
          if (await isBlockedFetchHostResolved(parsed.hostname)) {
            return {
              content: [{ type: "text", text: formatError(`${name} resolves to a private/loopback/link-local address (${parsed.hostname}) — refusing to forward it to the gateway.`) }],
              isError: true,
            };
          }
        }

        // Resolution ceilings, per model. Seedance and Grok both honour the
        // parameter and are checked against their own supported sets; only Sora
        // truly ignores it (probed: `resolution:"720p"` quotes the same
        // $0.421001 as the default), so for Sora alone it is DROPPED from the
        // body below rather than rejected — forwarding it there earns a gateway
        // 400, which is the opposite of "ignored".
        const seedanceRes = SEEDANCE_RESOLUTIONS[selectedModel] ?? GROK_RESOLUTIONS[selectedModel];
        if (resolution && seedanceRes && !seedanceRes.resolutions.has(resolution)) {
          return {
            content: [{ type: "text", text: formatError(`${selectedModel} does not render ${resolution}. ${seedanceRes.note}. Supported: ${[...seedanceRes.resolutions].join(", ")}.`) }],
            isError: true,
          };
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
        // Sent for every model that has a resolution table (Seedance + Grok).
        // Sora has none, and the gateway 400s a resolution it was sent there —
        // so honour "ignored" by not sending it, instead of failing a call over
        // a no-op parameter.
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
        // FAIL CLOSED on a quote we cannot price. amountToUsd returns null for
        // a missing / non-numeric / non-positive amount — and the old path then
        // SKIPPED the re-reserve, signed a payment for the raw unvalidated
        // amount, and booked only the estimate: the last remaining way past the
        // budget cap. Never sign what we could not read.
        if (settledUsd === null) {
          return {
            content: [{ type: "text", text: formatError(`The gateway's 402 quote carried an unreadable amount (${JSON.stringify(details.amount)}). Refusing to sign a payment for an amount that could not be validated — no charge was made. This is a gateway fault; retry, and report it if it persists.`) }],
            isError: true,
          };
        }

        // The 402 carries the REAL price; Seedance/Sora are token-priced, so a
        // 1080p/4K render can far exceed the per-second estimate reserved at
        // the gate. Re-reserve against the cap BEFORE paying so a single high-res
        // call can't settle past the budget (and concurrent jobs hold the true
        // amount, not the low estimate, for the whole polling window).
        if (settledUsd > estimatedCost) {
          gate?.release();
          gate = reserveBudget(budget, agent_id, settledUsd);
          if (!gate.allowed) {
            return { content: [{ type: "text", text: `${gate.reason}. Use blockrun_wallet action:"report" to see usage or action:"delegate" to increase agent budget.` }], isError: true };
          }
        }

        // Start the total budget before creating the 600s authorization so the
        // polling loop cannot accidentally consume its intended 60s margin.
        const startedAt = Date.now();
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
            maxTimeoutSeconds: Math.max(details.maxTimeoutSeconds || 0, VIDEO_PAYMENT_AUTH_SECONDS),
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

        let lastStatus = submitData.status || "queued";
        let spendBooked = false;
        let completed: {
          url: string;
          source_url?: string;
          duration_seconds?: number;
          request_id?: string;
          backed_up?: boolean;
          modelReturned?: string;
          txHash?: string;
        } | null = null;

        const deadline = startedAt + VIDEO_TOTAL_BUDGET_MS;

        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

          // Clamp to the budget that is actually left. Checking the deadline
          // only at the top of the loop bounds when a poll may START, not when
          // it finishes — an unclamped 90s poll entered just under the wire
          // stays in flight well past validBefore.
          const pollTimeoutMs = pollTimeoutFor(deadline, Date.now(), VIDEO_POLL_TIMEOUT_MS);
          if (pollTimeoutMs === 0) break;

          const pollResp = await fetchWithTimeout(pollAbsoluteUrl, {
            method: "GET",
            headers: { "PAYMENT-SIGNATURE": paymentPayload },
          }, pollTimeoutMs);

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

          // Settlement happens SERVER-SIDE on the first poll the gateway
          // answers with status "completed" — the USDC is gone the moment we
          // observe it, regardless of what the rest of the payload looks like.
          // Book immediately: the old path validated the payload first, so a
          // malformed completed body threw, the catch returned an error, and
          // finally released the reservation — a real charge the ledger never
          // saw, silently raising the cap by the lost amount.
          if (lastStatus === "completed" && !spendBooked) {
            recordActualSpend(budget, settledUsd, estimatedCost, agent_id);
            spendBooked = true;
          }

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
          throw new Error(`Video generation did not complete within ${Math.round(VIDEO_TOTAL_BUDGET_MS / 1000)}s (last status: ${lastStatus}). No payment was taken.`);
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
        // Backstop only — every reachable path here has already booked at the
        // poll site the moment "completed" was observed.
        if (!spendBooked) recordActualSpend(budget, settledUsd, estimatedCost, agent_id);

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
