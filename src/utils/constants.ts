import * as path from "path";
import * as os from "os";

export const WALLET_DIR = path.join(os.homedir(), ".blockrun");
export const WALLET_FILE = path.join(WALLET_DIR, ".session");
export const QR_FILE = path.join(WALLET_DIR, "qr.png");

export const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const BASE_CHAIN_ID = "8453";
export const BASE_CHAIN_ID_NUM = 8453;
export const BASE_RPC_URLS = [
  "https://mainnet.base.org",
  "https://base.llamarpc.com",
  "https://1rpc.io/base",
];

// Model catalogue, refreshed against the live GET /v1/models on 2026-07-20;
// free tier re-probed and corrected 2026-07-21 (see the free[] note below).
// Prices below are $/M input / $/M output as the gateway quotes them.
//
// A NOTE ON STALENESS: the gateway silently ALIASES retired IDs onto a live
// model rather than 404ing (the 2026-07-20 sweep found nvidia/llama-4-maverick
// answering as nvidia/gpt-oss-120b, and moonshot/kimi-k2.6 still quoting a
// price). So a dead entry here does NOT surface as an error — it quietly routes
// somewhere you did not choose. Only a genuinely unknown ID 400s. That is why
// these lists are checked against the catalogue rather than "tested by working".
//
// THE CONVERSE DOES NOT HOLD, and 0.32.1 was the cost of assuming it. Absence
// from GET /v1/models is a LISTING decision, not a death certificate: gpt-oss-120b
// and gpt-oss-20b are hidden from the catalogue and serving fine on both chains
// (120b is the gateway's own free fallback). State both clauses, because only one
// of them was written down last time and two live models got deleted for it:
//   presence in the catalogue is NECESSARY BUT NOT SUFFICIENT for health;
//   absence from it is NOT SUFFICIENT for death — probe before deleting.
//
// OpenAI (22): gpt-5.6-sol ($5/$30, 1M, deepest reasoning), gpt-5.6-terra
//   ($2.5/$15, 1M — the balanced default), gpt-5.6-luna ($1/$6, 1M, no
//   reasoning), gpt-5.5 ($5/$30), gpt-5.4 ($2.5/$15), gpt-5.4-pro ($30/$180,
//   the priciest model served), gpt-5.3 / gpt-5.2 / gpt-5.3-codex ($1.75/$14),
//   gpt-5.2-pro ($21/$168), gpt-5.4-mini, gpt-5-mini, gpt-5.4-nano, gpt-4.1{,
//   -mini,-nano}, gpt-4o{,-mini}, o1 ($15/$60), o3 ($2/$8), o3-mini, o4-mini
// Anthropic (8): claude-opus-4.8 ($5/$25, 1M — most capable), claude-fable-5
//   ($10/$50, 1M), claude-opus-4.7 ($5/$25, 1M), claude-sonnet-5 ($3/$15, 1M),
//   claude-opus-4.5, claude-sonnet-4.6, claude-sonnet-4.5, claude-haiku-4.5
// Google (7): gemini-3.1-pro ($2/$12), gemini-3.5-flash + gemini-3-flash-preview
//   ($0.5/$3), gemini-2.5-pro, gemini-2.5-flash, gemini-3.1-flash-lite,
//   gemini-2.5-flash-lite — all 1M context
// DeepSeek (3): deepseek-v4-pro ($0.435/$0.87, 1M, reasoning + coding — the
//   cheapest frontier-class option served), deepseek-chat, deepseek-reasoner
// Moonshot (1): kimi-k3 ($3/$15, 1M, vision + reasoning + coding). Supersedes
//   the k2.x line, which is gone from the catalogue.
// ZAI (4): glm-5.2 ($1.4/$4.4, 1M), glm-5.1 ($1.4/$4.4), glm-5 ($0.6/$1.92 —
//   still the cheapest ZAI), glm-5-turbo ($1.2/$4)
// xAI (3): grok-4.5 ($2.5/$9, 500K, native search), grok-4.3 ($1.5/$4, 1M),
//   grok-build-0.1 ($1.5/$3, coding)
// MiniMax (2): minimax-m3 ($0.3/$1.2, 1M), minimax-m2.7 ($0.3/$1.2, 200K)
// Qwen (1): qwen3.7-max ($1.475/$4.425, 1M)
// NVIDIA — genuinely $0. Serving healthy on the 2026-07-20 probe:
//   deepseek-v4-flash (1M context), mistral-nemotron, step-3.7-flash,
//   seed-oss-36b, nemotron-nano-9b-v2, nemotron-nano-12b-v2-vl (vision),
//   nemotron-3-nano-omni-30b-a3b-reasoning (vision).
//   Also live but UNLISTED (hidden from GET /v1/models, still served): gpt-oss-120b
//   — the gateway's own free fallback — and gpt-oss-20b.
//   Listed but too slow to route to: mistral-large-3-675b (123s on a real prompt).
//   Listed and fast, but ALIASED on Base, so not in free[]:
//   nemotron-3-nano-omni-30b-a3b-reasoning. It answers 200 in 2.0s — while
//   reporting `"model": "nvidia/gpt-oss-120b"` in the response body. On sol it
//   serves itself (3.8s). Routing to it on Base would therefore just be a slower
//   way to reach gpt-oss-120b, which is already free[0]. This is the aliasing
//   trap at the top of this file caught in the act; it is the reason the entry
//   stays documented-but-unrouted rather than quietly dropped.
export const MODEL_TIERS = {
  fast: ["google/gemini-3.5-flash", "google/gemini-2.5-flash", "google/gemini-3.1-flash-lite", "openai/gpt-5-mini", "deepseek/deepseek-chat", "google/gemini-3-flash-preview"],
  balanced: ["openai/gpt-5.6-terra", "anthropic/claude-sonnet-5", "moonshot/kimi-k3", "google/gemini-3.1-pro", "xai/grok-4.5", "openai/gpt-5.5"],
  powerful: ["anthropic/claude-opus-4.8", "openai/gpt-5.6-sol", "anthropic/claude-fable-5", "openai/gpt-5.4-pro", "anthropic/claude-opus-4.7", "openai/gpt-5.2-pro"],
  cheap: ["deepseek/deepseek-v4-pro", "minimax/minimax-m3", "zai/glm-5", "nvidia/deepseek-v4-flash", "google/gemini-2.5-flash", "deepseek/deepseek-chat", "openai/gpt-5.4-nano"],
  reasoning: ["anthropic/claude-opus-4.8", "openai/gpt-5.6-sol", "moonshot/kimi-k3", "xai/grok-4.3", "deepseek/deepseek-v4-pro", "openai/o3", "deepseek/deepseek-reasoner"],
  // 2026-07-20 sweep, CORRECTED 2026-07-21 (see below). Order matters: free[0]
  // is what every mode:"free" call tries first, and a slow primary stalls the
  // whole routing loop before it can fall through.
  //
  // DELISTED IS NOT DEAD. The previous pass dropped gpt-oss-120b and gpt-oss-20b
  // as "retired", reasoning that they only worked via server-side aliasing. That
  // was wrong, and the same sweep contained the disproof: llama-4-maverick was
  // observed "answering as gpt-oss-120b" — a model cannot be the alias TARGET and
  // be dead. Both are merely hidden from GET /v1/models; gpt-oss-120b is the
  // gateway's own FREE_FALLBACK_MODEL (and gpt-oss-20b its last-resort rung), so
  // it is the single most load-bearing free model there is. Re-probed 2026-07-21
  // on BOTH chains with a realistic ~1.5K-token prompt: gpt-oss-120b 3.5s,
  // gpt-oss-20b 3.7s, both 200 with real completions. Absence from the public
  // catalogue is a listing decision, not a health signal — check the behaviour.
  //
  // BEING LISTED IS NOT BEING ALIVE, EITHER — but state the failure accurately.
  // nvidia/mistral-large-3-675b is listed at $0 and stays excluded, though not
  // for the reason recorded before: it does NOT hang. It CRAWLS. A toy ping
  // ("say OK", 8 max_tokens) returns in 2s, which is exactly how it kept
  // re-certifying itself as healthy; the same model on a realistic 1.5K-token
  // prompt took 123.2s. That is the trap the gateway's own probe script added a
  // --real mode for. Never health-check a free model with a 16-token ping.
  free: ["nvidia/gpt-oss-120b", "nvidia/deepseek-v4-flash", "nvidia/mistral-nemotron", "nvidia/step-3.7-flash", "nvidia/seed-oss-36b", "nvidia/gpt-oss-20b", "nvidia/nemotron-nano-12b-v2-vl", "nvidia/nemotron-nano-9b-v2"],
  coding: ["anthropic/claude-opus-4.8", "openai/gpt-5.3-codex", "moonshot/kimi-k3", "xai/grok-build-0.1", "zai/glm-5.2", "qwen/qwen3.7-max", "anthropic/claude-sonnet-5"],
  glm: ["zai/glm-5", "zai/glm-5.2", "zai/glm-5.1", "zai/glm-5-turbo"],
} as const;

export type RoutingMode = keyof typeof MODEL_TIERS;

/**
 * Per-model and whole-loop deadlines for the mode:"free" routing fallback.
 *
 * Free NVIDIA models do not fail by erroring, they fail by CRAWLING — the
 * measurement that got mistral-large-3-675b excluded was 2s on a toy ping and
 * 123.2s on a real 1.5K-token prompt. The SDK's default request timeout is
 * 600s, so before these bounds existed a single degraded entry could hold an
 * MCP tool call for ten minutes before the loop fell through to the next model,
 * and a fully degraded tier for eight times that.
 *
 * Healthy free models answer a real prompt in 1.7-12s (measured 2026-07-21 on
 * both chains), so 60s is roughly a 5x margin over the slowest healthy case and
 * still leaves room for a long generation. A model that has not answered by
 * then is not worth waiting for when the next one is a second away.
 *
 * The cumulative deadline is what actually bounds what the caller feels: it
 * caps the whole loop regardless of how many models free[] holds, so adding a
 * ninth entry can never lengthen the worst case again.
 */
export const FREE_MODEL_TIMEOUT_MS = 60_000;
export const FREE_TIER_DEADLINE_MS = 150_000;

/**
 * The free NVIDIA path SILENTLY TRUNCATES the prompt at 128 KiB.
 *
 * Measured 2026-07-21, and the failure is invisible by design: the request
 * returns 200 with a confident, well-formed answer about whatever survived. No
 * error, no warning, no `finish_reason` signal. `usage.prompt_tokens` is the
 * only tell, and it flatlines:
 *
 *     sent 110,000 B -> prompt_tokens 22,065
 *     sent 125,000 B -> prompt_tokens 25,065
 *     sent 130,000 B -> prompt_tokens 26,065
 *     sent 135,000 B -> prompt_tokens 26,266   <- capped
 *     sent 150,000 B -> prompt_tokens 26,266   <- identical, 15 KB discarded
 *
 * Identical on gpt-oss-120b and deepseek-v4-flash, so it is a property of the
 * free path rather than of any one model's context window. It is NOT a
 * gateway-wide body cap: paid models scale linearly right past it — the 402
 * quote for gpt-5.6-terra reads ~12,016 input tokens at 25 KB and ~192,016 at
 * 400 KB, with no ceiling.
 *
 * Practical consequence: the "1M context" noted against deepseek-v4-flash in the
 * catalogue above is unreachable on the free tier. Anything over this limit needs
 * an explicit paid model. blockrun_chat warns the caller instead of letting a
 * truncated answer pass as a complete one — see freeTierTruncationNote().
 */
export const FREE_TIER_MAX_PROMPT_BYTES = 131_072; // 128 KiB

export const BASE_TOKENS: Record<string, string> = {
  ETH: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
  WETH: "0x4200000000000000000000000000000000000006",
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  USDbC: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA",
  DAI: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb",
  cbETH: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22",
};

