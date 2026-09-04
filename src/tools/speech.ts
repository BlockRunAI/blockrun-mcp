// src/tools/speech.ts
//
// AI voice via BlockRun x402 — text-to-speech (ElevenLabs + ByteDance Seed
// Audio), sound effects, and free voice discovery. Mirrors the music.ts
// manual-402 pattern (Base only).
//
// Pricing mirrors the server exactly. ElevenLabs: (chars / 1000) × rate × 1.05
// margin, minimum $0.001 per request; sound effects flat $0.05 × 1.05 =
// $0.0525. Seed Audio bills per estimated output second instead — see
// SEED_AUDIO. Price is deterministic from input length, so the budget
// pre-check records the same amount the server settles.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TOOL_ANNOTATIONS } from "../tool-annotations.js";
import { z } from "zod";
import { amountToUsd, reserveBudget, recordActualSpend } from "../utils/budget.js";
import { confirmSpend } from "../utils/confirm-spend.js";
import { withTxFee } from "../utils/tx-fee.js";
import { formatError, isPaymentRejectionError } from "../utils/errors.js";
import { launchTopUp } from "../utils/onramp.js";
import { fetchWithTimeout, isTimeoutError } from "../utils/http.js";
import type { BudgetState } from "../types.js";
import { getChain, getOrCreateWalletKey } from "../utils/wallet.js";
import { isAccountMode, accountJson, PORTAL_URL } from "../utils/account.js";
import { privateKeyToAccount } from "viem/accounts";
import {
  createPaymentPayload,
  parsePaymentRequired,
  extractPaymentDetails,
} from "@blockrun/llm";

const BLOCKRUN_API = "https://blockrun.ai/api";
// TTS is synchronous — the HTTP call stays open for the whole synthesis. Flash
// answers in <1s and the ElevenLabs models are comfortably inside a minute, but
// 0.40.0 added bytedance/seed-audio-1.0, which can emit up to 120 SECONDS of
// audio from a single 3k-character prompt. A 60s cap therefore aborted a call
// whose payment signature had already been sent: the clip is lost, and because
// booking only happens after resp.ok, a settlement that did go through is never
// recorded. 180s covers the 120s ceiling with margin.
const SPEECH_TIMEOUT = 180_000;
const VOICES_TIMEOUT = 15_000;
const MARGIN = 1.05; // 5% platform fee, baked into the server's quoted price
const MIN_PAYMENT_USD = 0.001;
// withTxFee: the sweep that fixed speechCost() four lines below skipped this
// constant. Live-verified: audio/sound-effects charges 54501 micro ($0.054501)
// against a $0.0525 reserve. withTxFee ceils, matching the server — a plain
// round would land on $0.054500, one micro short.
const SOUND_EFFECT_COST = withTxFee(0.05 * MARGIN);

// Per-model $/1k chars and max input — mirrors SPEECH_MODELS in the gateway.
const SPEECH_MODELS: Record<string, { pricePer1kChars: number; maxInputChars: number }> = {
  "elevenlabs/flash-v2.5": { pricePer1kChars: 0.05, maxInputChars: 40_000 },
  "elevenlabs/turbo-v2.5": { pricePer1kChars: 0.05, maxInputChars: 40_000 },
  "elevenlabs/multilingual-v2": { pricePer1kChars: 0.1, maxInputChars: 10_000 },
  "elevenlabs/v3": { pricePer1kChars: 0.1, maxInputChars: 5_000 },
  // Display-only $/1k for seed-audio: it actually bills by ESTIMATED OUTPUT
  // SECONDS — see SEED_AUDIO below. This entry exists so the maxInputChars
  // check and the `?? flash` fallback lookup treat it like any other model.
  "bytedance/seed-audio-1.0": { pricePer1kChars: 0.3, maxInputChars: 3_000 },
};

// bytedance/seed-audio-1.0 (added 2026-08-12) is priced per SECOND of output,
// estimated from input length before generation: seconds = latinChars x 0.105
// + cjkChars x 0.225, capped at 120s of output, x $0.003/sec. Mirrors
// estimateSpeechSeconds()/calculateSpeechPrice() in the gateway EXACTLY,
// including two deliberate asymmetries vs the ElevenLabs formula:
//   - the $0.003/sec rate is FINAL RETAIL — the gateway does NOT apply the 5%
//     margin on top, so neither do we (MARGIN would over-reserve 5%);
//   - CJK codepoints speak slower per character (~4.7 vs ~10 chars/sec
//     measured on Seed Audio), so a CJK prompt quotes ~2x its Latin length.
// The 402's quoted amount still wins for billing; this only feeds the gate.
const SEED_AUDIO = {
  model: "bytedance/seed-audio-1.0",
  pricePerSecond: 0.003,
  secondsPerCharLatin: 0.105,
  secondsPerCharCJK: 0.225,
  maxOutputSeconds: 120,
};

// Gateway's CJK_RE verbatim (Han, Hiragana/Katakana, Hangul + width forms).
const CJK_RE = /[\u2E80-\u2FDF\u3000-\u303F\u3040-\u30FF\u31C0-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF00-\uFFEF]/g;

// Built-in voice aliases — duplicated from the gateway so action:"voices"
// stays useful even when the free /v1/audio/voices endpoint is down.
const VOICE_ALIASES: Array<{ alias: string; description: string }> = [
  { alias: "sarah", description: "Mature, reassuring, confident (default)" },
  { alias: "george", description: "Warm, captivating storyteller" },
  { alias: "laura", description: "Enthusiast, quirky" },
  { alias: "charlie", description: "Deep, confident, energetic" },
  { alias: "river", description: "Relaxed, neutral, informative" },
  { alias: "roger", description: "Laid-back, casual, resonant" },
  { alias: "callum", description: "Husky trickster" },
  { alias: "harry", description: "Fierce warrior" },
];

export function speechCost(model: string, input: string): number {
  if (model === SEED_AUDIO.model) {
    const cjkCount = (input.match(CJK_RE) || []).length;
    const estSeconds = Math.min(
      (input.length - cjkCount) * SEED_AUDIO.secondsPerCharLatin + cjkCount * SEED_AUDIO.secondsPerCharCJK,
      SEED_AUDIO.maxOutputSeconds,
    );
    return withTxFee(Math.max(estSeconds * SEED_AUDIO.pricePerSecond, MIN_PAYMENT_USD));
  }
  const m = SPEECH_MODELS[model];
  const raw = (input.length / 1000) * (m?.pricePer1kChars ?? 0.05) * MARGIN;
  // MIN_PAYMENT_USD mirrors the server's BASE floor, not its charge: the gateway
  // adds a flat $0.002 tx fee on top, and its own route says so —
  // "Price = (characters / 1000) x model rate, minimum $0.003/request"
  // (api/v1/audio/speech/route.ts). Reserving the $0.001 floor was 3x short on
  // every short render; a 10k-char one was $0.002 short.
  return withTxFee(Math.max(raw, MIN_PAYMENT_USD));
}

export function registerSpeechTool(server: McpServer, budget: BudgetState): void {
  server.registerTool(
    "blockrun_speech",
    {
      description: `AI voice via BlockRun x402 — speak text aloud (ElevenLabs or ByteDance Seed Audio), generate sound effects, list voices.

Actions:
- speak (default): text-to-speech. E.g. "speak this with the sarah voice". Price = chars/1000 × rate (min $0.001), quoted before payment.
- sound_effect: cinematic sound effects from a text prompt, up to 22s ($0.0525/clip)
- voices: list available voices (free)

Models (speak): elevenlabs/flash-v2.5 ($0.05/1k chars, ~75ms, default), elevenlabs/turbo-v2.5 ($0.05/1k), elevenlabs/multilingual-v2 ($0.10/1k, narration), elevenlabs/v3 ($0.10/1k, most expressive), bytedance/seed-audio-1.0 (~$0.003/sec of output, est. from input length; max 3k chars in / 120s out) — prompt-DIRECTED audio: describe the voice, emotion, and sound staging in the input text itself ("a tired detective mutters, rain in the background: ..."); the voice parameter is ignored.

Voice aliases (ElevenLabs models only): sarah (default), george, laura, charlie, river, roger, callum, harry — or any raw ElevenLabs voice_id.

Returns a hosted audio URL — download immediately if you need to keep the file.`,
      annotations: TOOL_ANNOTATIONS.generative,
      inputSchema: {
        action: z.enum(["speak", "sound_effect", "voices"]).optional().default("speak").describe("speak: text-to-speech (default). sound_effect: generate a sound effect. voices: list voices (free)."),
        input: z.string().optional().describe("speak: text to synthesize. sound_effect: description of the sound, e.g. 'rain on a tin roof, distant thunder' (max 1000 chars)."),
        voice: z.string().optional().describe("Voice alias (sarah, george, laura, charlie, river, roger, callum, harry) or raw ElevenLabs voice_id. Default: sarah."),
        model: z.enum(["elevenlabs/flash-v2.5", "elevenlabs/turbo-v2.5", "elevenlabs/multilingual-v2", "elevenlabs/v3", "bytedance/seed-audio-1.0"]).optional().default("elevenlabs/flash-v2.5").describe("Speech model (speak only). seed-audio-1.0 is prompt-directed: voice/emotion/staging go in the input text, the voice param is ignored, and billing is per estimated second of output."),
        response_format: z.enum(["mp3", "opus", "pcm", "wav"]).optional().default("mp3").describe("Audio format"),
        speed: z.number().min(0.7).max(1.2).optional().describe("Playback speed 0.7-1.2 (speak only)"),
        duration_seconds: z.number().min(0.5).max(22).optional().describe("Sound effect length in seconds (sound_effect only; default: auto)"),
        prompt_influence: z.number().min(0).max(1).optional().describe("How literally to follow the prompt, 0-1 (sound_effect only)"),
        agent_id: z.string().optional().describe("Agent identifier for budget tracking and enforcement."),
      },
    },
    async ({ action, input, voice, model, response_format, speed, duration_seconds, prompt_influence, agent_id }) => {
      // Reserve the estimate up front so concurrent calls can't each pass a
      // stale budget; release in finally once the call settles or fails.
      let gate: ReturnType<typeof reserveBudget> | undefined;
      try {
        if (action === "voices") {
          return await listVoices();
        }

        if (!isAccountMode() && getChain() !== "base") {
          return {
            content: [{ type: "text", text: formatError("blockrun_speech currently settles on Base only. Switch BlockRun to Base (for example: run blockrun_wallet with action:chain chain:base) and fund the Base wallet with USDC.") }],
            isError: true,
          };
        }

        if (!input?.trim()) {
          return {
            content: [{ type: "text", text: formatError(`'input' is required for action:"${action}" — the text to ${action === "speak" ? "synthesize" : "describe the sound effect"}.`) }],
            isError: true,
          };
        }

        let endpoint: string;
        let body: Record<string, unknown>;
        let cost: number;

        if (action === "sound_effect") {
          if (input.length > 1000) {
            return {
              content: [{ type: "text", text: formatError(`Sound effect description too long: ${input.length} characters (max 1000).`) }],
              isError: true,
            };
          }
          endpoint = `${BLOCKRUN_API}/v1/audio/sound-effects`;
          body = { model: "elevenlabs/sound-effects", text: input, response_format };
          if (duration_seconds !== undefined) body.duration_seconds = duration_seconds;
          if (prompt_influence !== undefined) body.prompt_influence = prompt_influence;
          cost = SOUND_EFFECT_COST;
        } else {
          // Defensive default — the MCP SDK applies the zod default, but a
          // direct caller may omit model.
          const modelInfo = SPEECH_MODELS[model] ?? SPEECH_MODELS["elevenlabs/flash-v2.5"];
          if (input.length > modelInfo.maxInputChars) {
            return {
              content: [{ type: "text", text: formatError(`Input too long: ${input.length.toLocaleString("en-US")} characters (max ${modelInfo.maxInputChars.toLocaleString("en-US")} for ${model}). Split the text or use elevenlabs/flash-v2.5 (40k max).`) }],
              isError: true,
            };
          }
          endpoint = `${BLOCKRUN_API}/v1/audio/speech`;
          body = { model, input, voice: voice || "sarah", response_format };
          if (speed !== undefined) body.speed = speed;
          cost = speechCost(model, input);
        }

        gate = reserveBudget(budget, agent_id, cost);
        if (!gate.allowed) {
          return {
            content: [{ type: "text", text: `${gate.reason}. Use blockrun_wallet action:"report" to see usage or action:"delegate" to increase agent budget.` }],
            isError: true,
          };
        }
        // Human-in-the-loop (BLOCKRUN_CONFIRM_SPEND=on): ask before signing. A
        // decline returns here — nothing is sent, and the finally releases the
        // reservation. No-ops when off, sub-threshold, or unsupported by the client.
        const confirm = await confirmSpend(server, { usd: cost, label: `speech · ${action === "sound_effect" ? "sound effect" : model}` });
        if (!confirm.ok) return { content: [{ type: "text", text: confirm.reason ?? "Charge cancelled." }] };

        if (isAccountMode()) {
          const route=action === "sound_effect" ? "/v1/audio/sound-effects" : "/v1/audio/speech";
          const data=await accountJson(route,body,SPEECH_TIMEOUT) as {data?:Array<{url?:string;format?:string}>;model?:string};const clip=data.data?.[0];if(!clip?.url)throw new Error("No audio URL in account response");
          return {content:[{type:"text",text:`Audio ready!\nURL: ${clip.url}\nBilling: account credits (${PORTAL_URL}/dashboard/credits)`}],structuredContent:{url:clip.url,model:data.model||model,auth_mode:"api-key",cost_source:"account_portal"}};
        }
        const privateKey = getOrCreateWalletKey();
        const account = privateKeyToAccount(privateKey);

        // Step 1: get 402 with the exact quoted price
        const resp402 = await fetchWithTimeout(endpoint, {
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
        // Prefer the exact 402-quoted price (handles sound-effect duration and any
        // server-side price change) over the local estimate for billing + display.
        const billedUsd = amountToUsd(details.amount) ?? cost;

        const paymentPayload = await createPaymentPayload(
          privateKey,
          account.address,
          details.recipient,
          details.amount,
          details.network || "eip155:8453",
          {
            resourceUrl: details.resource?.url || endpoint,
            resourceDescription: details.resource?.description || "BlockRun Speech",
            maxTimeoutSeconds: details.maxTimeoutSeconds || 300,
            extra: details.extra,
          }
        );

        // Step 2: synthesize with payment (settlement happens after generation)
        const resp = await fetchWithTimeout(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "PAYMENT-SIGNATURE": paymentPayload,
          },
          body: JSON.stringify(body),
        }, SPEECH_TIMEOUT);

        if (resp.status === 402) {
          throw new Error("Payment rejected. Check your wallet balance.");
        }

        if (!resp.ok) {
          const errBody = await resp.json().catch(() => ({ error: "Request failed" })) as Record<string, unknown>;
          throw new Error(`API error ${resp.status}: ${JSON.stringify(errBody)}`);
        }

        // A 200 means the call settled on-chain (X-Payment-Receipt is set). Book
        // the charge NOW, before reading the body — a truncated/unreadable body
        // below must not un-record a spend that already left the wallet.
        const txHash = resp.headers.get("X-Payment-Receipt") || resp.headers.get("x-payment-receipt");
        recordActualSpend(budget, billedUsd, cost, agent_id);

        const data = await resp.json() as {
          data: Array<{ url: string; format?: string; characters?: number; duration_seconds?: number }>;
          model?: string;
        };

        const clip = data.data?.[0];
        if (!clip?.url) throw new Error("No audio URL in response");

        const lines = [
          action === "sound_effect" ? `🔊 Sound effect ready!` : `🗣️ Speech ready!`,
          `URL: ${clip.url}`,
          `Format: ${clip.format || response_format}`,
          ...(clip.characters !== undefined ? [`Characters: ${clip.characters}`] : []),
          ...(clip.duration_seconds !== undefined ? [`Duration: ${clip.duration_seconds}s`] : []),
          `Model: ${data.model || (action === "sound_effect" ? "elevenlabs/sound-effects" : model)}`,
          `Cost: $${billedUsd.toFixed(4)}`,
          ...(txHash ? [`Tx: ${txHash}`] : []),
          ``,
          `Note: This URL may expire — download it now if you need to keep the file.`,
        ];

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          structuredContent: {
            url: clip.url,
            format: clip.format || response_format,
            ...(clip.characters !== undefined ? { characters: clip.characters } : {}),
            ...(clip.duration_seconds !== undefined ? { duration_seconds: clip.duration_seconds } : {}),
            model: data.model || (action === "sound_effect" ? "elevenlabs/sound-effects" : model),
            cost_usd: billedUsd,
            ...(txHash ? { txHash } : {}),
          },
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (isPaymentRejectionError(errMsg)) {
          return {
            content: [{ type: "text", text: `Speech generation needs USDC — your wallet is out of funds. ${(await launchTopUp()).note}\nError: ${errMsg}` }],
            isError: true,
          };
        }
        if (isTimeoutError(err)) {
          return {
            content: [{ type: "text", text: `Speech generation timed out after ${SPEECH_TIMEOUT / 1000}s. The payment signature had already been sent, so a charge MAY have settled without returning audio — check blockrun_wallet action:"report" before retrying.\nError: ${errMsg}` }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: formatError(`Speech generation failed: ${errMsg}`) }],
          isError: true,
        };
      } finally {
        gate?.release();
      }
    }
  );
}

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

// Free voice discovery. Falls back to the built-in aliases when the gateway
// endpoint is unavailable, so agents can always pick a voice.
async function listVoices(): Promise<ToolResult> {
  try {
    const resp = await fetchWithTimeout(`${BLOCKRUN_API}/v1/audio/voices`, { method: "GET" }, VOICES_TIMEOUT);
    if (resp.ok) {
      const payload = await resp.json() as {
        data?: Array<{ voice_id: string; name?: string; alias?: string; category?: string; labels?: Record<string, string> }>;
      };
      const voices = payload.data || [];
      if (voices.length > 0) {
        const lines = voices.map((v) => {
          const tags = v.labels ? Object.values(v.labels).join(", ") : "";
          return `- ${v.alias ? `${v.alias} ` : ""}(${v.voice_id})${v.name ? ` — ${v.name}` : ""}${tags ? ` [${tags}]` : ""}`;
        });
        return {
          content: [{ type: "text", text: `Available voices (pass alias or voice_id as 'voice'):\n${lines.join("\n")}` }],
          structuredContent: { voices },
        };
      }
    }
  } catch {
    // fall through to built-in aliases
  }

  const lines = VOICE_ALIASES.map((v) => `- ${v.alias} — ${v.description}`);
  return {
    content: [{ type: "text", text: `Built-in voice aliases (pass as 'voice'; full catalog temporarily unavailable):\n${lines.join("\n")}\n\nAny raw ElevenLabs voice_id also works.` }],
    structuredContent: { voices: VOICE_ALIASES },
  };
}
