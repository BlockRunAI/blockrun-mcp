// src/tools/music.ts
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
const MUSIC_TIMEOUT = 200_000; // 200s — music gen takes 1-3 min
const MUSIC_COST = 0.1575;

export function registerMusicTool(server: McpServer, budget: BudgetState): void {
  server.registerTool(
    "blockrun_music",
    {
      description: `Generate music tracks via BlockRun x402.

Generates a full-length ~3 minute MP3 track. Takes 1-3 minutes to complete.

Models: minimax/music-2.5+ ($0.1575), minimax/music-2.5 ($0.1575)

Returns a time-limited CDN URL — download immediately if you need to keep the file.`,
      inputSchema: {
        prompt: z.string().describe("Music style, mood, or description. E.g. 'upbeat synthwave with neon pads', 'chill lo-fi beats', 'epic orchestral film score'"),
        instrumental: z.boolean().optional().default(true).describe("Generate without vocals (default: true)"),
        lyrics: z.string().optional().describe("Custom lyrics. Cannot be used with instrumental: true"),
        model: z.enum(["minimax/music-2.5+", "minimax/music-2.5"]).optional().default("minimax/music-2.5+").describe("Music model to use"),
        agent_id: z.string().optional().describe("Agent identifier for budget tracking and enforcement."),
      },
    },
    async ({ prompt, instrumental, lyrics, model, agent_id }) => {
      try {
        if (getChain() !== "base") {
          return {
            content: [{ type: "text", text: formatError("blockrun_music currently settles on Base only. Switch BlockRun to Base (for example: write 'base' to ~/.blockrun/.chain) and fund the Base wallet with USDC.") }],
            isError: true,
          };
        }

        if (instrumental && lyrics?.trim()) {
          return {
            content: [{ type: "text", text: formatError("Cannot specify lyrics when instrumental is true") }],
            isError: true,
          };
        }

        const budgetCheck = checkBudget(budget, agent_id, MUSIC_COST);
        if (!budgetCheck.allowed) {
          return {
            content: [{ type: "text", text: `${budgetCheck.reason}. Use blockrun_wallet action:"report" to see usage or action:"delegate" to increase agent budget.` }],
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
            resourceUrl: details.resource?.url || url,
            resourceDescription: details.resource?.description || "BlockRun Music Generation",
            maxTimeoutSeconds: details.maxTimeoutSeconds || 300,
            extra: details.extra,
          }
        );

        // Step 2: generate with payment (takes 1-3 min)
        const resp = await fetchWithTimeout(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "PAYMENT-SIGNATURE": paymentPayload,
          },
          body: JSON.stringify(body),
        }, MUSIC_TIMEOUT);

        if (resp.status === 402) {
          throw new Error("Payment rejected. Check your wallet balance.");
        }

        if (!resp.ok) {
          const errBody = await resp.json().catch(() => ({ error: "Request failed" })) as Record<string, unknown>;
          throw new Error(`API error ${resp.status}: ${JSON.stringify(errBody)}`);
        }

        const data = await resp.json() as {
          data: Array<{ url: string; duration_seconds?: number; lyrics?: string }>;
          model?: string;
        };

        const track = data.data?.[0];
        if (!track?.url) throw new Error("No track URL in response");

        const txHash = resp.headers.get("X-Payment-Receipt") || resp.headers.get("x-payment-receipt");
        recordSpending(budget, MUSIC_COST, agent_id);

        const lines = [
          `🎵 Track ready!`,
          `URL: ${track.url}`,
          `Duration: ${track.duration_seconds ? `${track.duration_seconds}s` : "~3 min"}`,
          `Model: ${data.model || model}`,
          ...(track.lyrics ? [`Lyrics: ${track.lyrics.slice(0, 200)}${track.lyrics.length > 200 ? "..." : ""}`] : []),
          ...(txHash ? [`Tx: ${txHash}`] : []),
          ``,
          `Note: This URL expires in ~24h. Download it now if you need to keep the file.`,
        ];

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          structuredContent: {
            url: track.url,
            duration_seconds: track.duration_seconds,
            model: data.model || model,
            ...(track.lyrics ? { lyrics: track.lyrics } : {}),
            ...(txHash ? { txHash } : {}),
          },
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.includes("balance") || errMsg.includes("payment") || errMsg.includes("402") || errMsg.includes("rejected")) {
          return {
            content: [{ type: "text", text: `Music generation requires payment. Run blockrun_wallet with action: "setup" for funding instructions.\nError: ${errMsg}` }],
            isError: true,
          };
        }
        if (errMsg.includes("abort") || errMsg.includes("timeout") || errMsg.includes("Timeout")) {
          return {
            content: [{ type: "text", text: `Music generation timed out. This can happen during peak load — please try again.\nError: ${errMsg}` }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: formatError(`Music generation failed: ${errMsg}`) }],
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
