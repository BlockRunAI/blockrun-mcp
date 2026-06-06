// src/tools/speech.ts
//
// ElevenLabs voice via BlockRun x402 — text-to-speech, sound effects, and
// free voice discovery. Mirrors the music.ts manual-402 pattern (Base only).
//
// Pricing mirrors the server exactly: (chars / 1000) × rate × 1.05 margin,
// minimum $0.001 per request. Sound effects are flat $0.05 × 1.05 = $0.0525.
// Price is deterministic from input length, so the budget pre-check records
// the same amount the server settles.

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
const SPEECH_TIMEOUT = 60_000; // TTS is synchronous (<1s for Flash); 60s covers long multilingual-v2 inputs
const VOICES_TIMEOUT = 15_000;
const MARGIN = 1.05; // 5% platform fee, baked into the server's quoted price
const MIN_PAYMENT_USD = 0.001;
const SOUND_EFFECT_COST = 0.05 * MARGIN;

// Per-model $/1k chars and max input — mirrors SPEECH_MODELS in the gateway.
const SPEECH_MODELS: Record<string, { pricePer1kChars: number; maxInputChars: number }> = {
  "elevenlabs/flash-v2.5": { pricePer1kChars: 0.05, maxInputChars: 40_000 },
  "elevenlabs/turbo-v2.5": { pricePer1kChars: 0.05, maxInputChars: 40_000 },
  "elevenlabs/multilingual-v2": { pricePer1kChars: 0.1, maxInputChars: 10_000 },
  "elevenlabs/v3": { pricePer1kChars: 0.1, maxInputChars: 5_000 },
};

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

function speechCost(model: string, charCount: number): number {
  const m = SPEECH_MODELS[model];
  const raw = (charCount / 1000) * (m?.pricePer1kChars ?? 0.05) * MARGIN;
  return Math.max(raw, MIN_PAYMENT_USD);
}

export function registerSpeechTool(server: McpServer, budget: BudgetState): void {
  server.registerTool(
    "blockrun_speech",
    {
      description: `ElevenLabs voice via BlockRun x402 — speak text aloud, generate sound effects, list voices.

Actions:
- speak (default): text-to-speech. E.g. "speak this with the sarah voice". Price = chars/1000 × rate (min $0.001), quoted before payment.
- sound_effect: cinematic sound effects from a text prompt, up to 22s ($0.0525/clip)
- voices: list available voices (free)

Models (speak): elevenlabs/flash-v2.5 ($0.05/1k chars, ~75ms, default), elevenlabs/turbo-v2.5 ($0.05/1k), elevenlabs/multilingual-v2 ($0.10/1k, narration), elevenlabs/v3 ($0.10/1k, most expressive)

Voice aliases: sarah (default), george, laura, charlie, river, roger, callum, harry — or any raw ElevenLabs voice_id.

Returns a hosted audio URL — download immediately if you need to keep the file.`,
      inputSchema: {
        action: z.enum(["speak", "sound_effect", "voices"]).optional().default("speak").describe("speak: text-to-speech (default). sound_effect: generate a sound effect. voices: list voices (free)."),
        input: z.string().optional().describe("speak: text to synthesize. sound_effect: description of the sound, e.g. 'rain on a tin roof, distant thunder' (max 1000 chars)."),
        voice: z.string().optional().describe("Voice alias (sarah, george, laura, charlie, river, roger, callum, harry) or raw ElevenLabs voice_id. Default: sarah."),
        model: z.enum(["elevenlabs/flash-v2.5", "elevenlabs/turbo-v2.5", "elevenlabs/multilingual-v2", "elevenlabs/v3"]).optional().default("elevenlabs/flash-v2.5").describe("Speech model (speak only)"),
        response_format: z.enum(["mp3", "opus", "pcm", "wav"]).optional().default("mp3").describe("Audio format"),
        speed: z.number().min(0.7).max(1.2).optional().describe("Playback speed 0.7-1.2 (speak only)"),
        duration_seconds: z.number().min(0.5).max(22).optional().describe("Sound effect length in seconds (sound_effect only; default: auto)"),
        prompt_influence: z.number().min(0).max(1).optional().describe("How literally to follow the prompt, 0-1 (sound_effect only)"),
        agent_id: z.string().optional().describe("Agent identifier for budget tracking and enforcement."),
      },
    },
    async ({ action, input, voice, model, response_format, speed, duration_seconds, prompt_influence, agent_id }) => {
      try {
        if (action === "voices") {
          return await listVoices();
        }

        if (getChain() !== "base") {
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
          cost = speechCost(model, input.length);
        }

        const budgetCheck = checkBudget(budget, agent_id, cost);
        if (!budgetCheck.allowed) {
          return {
            content: [{ type: "text", text: `${budgetCheck.reason}. Use blockrun_wallet action:"report" to see usage or action:"delegate" to increase agent budget.` }],
            isError: true,
          };
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

        const data = await resp.json() as {
          data: Array<{ url: string; format?: string; characters?: number; duration_seconds?: number }>;
          model?: string;
        };

        const clip = data.data?.[0];
        if (!clip?.url) throw new Error("No audio URL in response");

        const txHash = resp.headers.get("X-Payment-Receipt") || resp.headers.get("x-payment-receipt");
        recordSpending(budget, cost, agent_id);

        const lines = [
          action === "sound_effect" ? `🔊 Sound effect ready!` : `🗣️ Speech ready!`,
          `URL: ${clip.url}`,
          `Format: ${clip.format || response_format}`,
          ...(clip.characters !== undefined ? [`Characters: ${clip.characters}`] : []),
          ...(clip.duration_seconds !== undefined ? [`Duration: ${clip.duration_seconds}s`] : []),
          `Model: ${data.model || (action === "sound_effect" ? "elevenlabs/sound-effects" : model)}`,
          `Cost: $${cost.toFixed(4)}`,
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
            cost_usd: cost,
            ...(txHash ? { txHash } : {}),
          },
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.includes("balance") || errMsg.includes("payment") || errMsg.includes("402") || errMsg.includes("rejected")) {
          return {
            content: [{ type: "text", text: `Speech generation requires payment. Run blockrun_wallet with action: "setup" for funding instructions.\nError: ${errMsg}` }],
            isError: true,
          };
        }
        if (errMsg.includes("abort") || errMsg.includes("timeout") || errMsg.includes("Timeout")) {
          return {
            content: [{ type: "text", text: `Speech generation timed out — please try again.\nError: ${errMsg}` }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: formatError(`Speech generation failed: ${errMsg}`) }],
          isError: true,
        };
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

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}
