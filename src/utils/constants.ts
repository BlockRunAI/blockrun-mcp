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

// Model catalogue, refreshed against the live GET /v1/models on 2026-07-20.
// Prices below are $/M input / $/M output as the gateway quotes them.
//
// A NOTE ON STALENESS: the gateway silently ALIASES retired IDs onto a live
// model rather than 404ing (the 2026-07-20 sweep found nvidia/llama-4-maverick
// answering as nvidia/gpt-oss-120b, and moonshot/kimi-k2.6 still quoting a
// price). So a dead entry here does NOT surface as an error — it quietly routes
// somewhere you did not choose. Only a genuinely unknown ID 400s. That is why
// these lists are checked against the catalogue rather than "tested by working".
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
//   Listed but NOT serving — do NOT route to: mistral-large-3-675b (hangs).
export const MODEL_TIERS = {
  fast: ["google/gemini-3.5-flash", "google/gemini-2.5-flash", "google/gemini-3.1-flash-lite", "openai/gpt-5-mini", "deepseek/deepseek-chat", "google/gemini-3-flash-preview"],
  balanced: ["openai/gpt-5.6-terra", "anthropic/claude-sonnet-5", "moonshot/kimi-k3", "google/gemini-3.1-pro", "xai/grok-4.5", "openai/gpt-5.5"],
  powerful: ["anthropic/claude-opus-4.8", "openai/gpt-5.6-sol", "anthropic/claude-fable-5", "openai/gpt-5.4-pro", "anthropic/claude-opus-4.7", "openai/gpt-5.2-pro"],
  cheap: ["deepseek/deepseek-v4-pro", "minimax/minimax-m3", "zai/glm-5", "nvidia/deepseek-v4-flash", "google/gemini-2.5-flash", "deepseek/deepseek-chat", "openai/gpt-5.4-nano"],
  reasoning: ["anthropic/claude-opus-4.8", "openai/gpt-5.6-sol", "moonshot/kimi-k3", "xai/grok-4.3", "deepseek/deepseek-v4-pro", "openai/o3", "deepseek/deepseek-reasoner"],
  // 2026-07-20 sweep: the previous list was 4/5 retired (llama-4-maverick,
  // qwen3-coder-480b, gpt-oss-120b, gpt-oss-20b) and only "worked" via the
  // server-side aliasing described above.
  //
  // Every entry below was live-probed and returned a completion. Being IN the
  // catalogue is not sufficient: nvidia/mistral-large-3-675b is listed at $0 but
  // hangs — no response, no error, connection open past 90s (the NIM-hung mode
  // seen in earlier sweeps) — so it is deliberately excluded. Order matters:
  // free[0] is what every mode:"free" call tries first, and a hung primary
  // stalls the whole routing loop before it can fall through.
  free: ["nvidia/deepseek-v4-flash", "nvidia/mistral-nemotron", "nvidia/step-3.7-flash", "nvidia/seed-oss-36b", "nvidia/nemotron-nano-12b-v2-vl", "nvidia/nemotron-nano-9b-v2"],
  coding: ["anthropic/claude-opus-4.8", "openai/gpt-5.3-codex", "moonshot/kimi-k3", "xai/grok-build-0.1", "zai/glm-5.2", "qwen/qwen3.7-max", "anthropic/claude-sonnet-5"],
  glm: ["zai/glm-5", "zai/glm-5.2", "zai/glm-5.1", "zai/glm-5-turbo"],
} as const;

export type RoutingMode = keyof typeof MODEL_TIERS;

export const BASE_TOKENS: Record<string, string> = {
  ETH: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
  WETH: "0x4200000000000000000000000000000000000006",
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  USDbC: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA",
  DAI: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb",
  cbETH: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22",
};

