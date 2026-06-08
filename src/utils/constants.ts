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

// Models organized by provider:
// OpenAI (13): openai/gpt-5.4, openai/gpt-5.4-pro, openai/gpt-5.3, openai/gpt-5.2,
//   openai/gpt-5.4-mini, openai/gpt-5-mini, openai/gpt-5.4-nano, openai/gpt-5.2-pro,
//   openai/gpt-5.3-codex, openai/o1, openai/o1-mini, openai/o3, openai/o3-mini
// Anthropic (flagships): anthropic/claude-opus-4.8 (most capable, 1M context, 128k output),
//   anthropic/claude-opus-4.7 (1M context), anthropic/claude-opus-4.6, anthropic/claude-sonnet-4.6,
//   anthropic/claude-haiku-4.5 (plus opus-4.5, opus-4, sonnet-4 legacy)
// Google (8): google/gemini-3.1-pro, google/gemini-3-pro-preview, google/gemini-3.5-flash
//   (latest flash, thinking, $0.5/$3), google/gemini-3-flash-preview, google/gemini-2.5-pro,
//   google/gemini-2.5-flash, google/gemini-3.1-flash-lite, google/gemini-2.5-flash-lite
// DeepSeek (2): deepseek/deepseek-chat, deepseek/deepseek-reasoner
// Moonshot (2): moonshot/kimi-k2.6 (flagship, $0.95/$4, vision + reasoning), moonshot/kimi-k2.5 (legacy)
// NVIDIA FREE — serving healthy as of the 2026-06-07 sweep: nvidia/llama-4-maverick
//   (general workhorse), nvidia/qwen3-coder-480b (coding), nvidia/deepseek-v4-flash
//   (1M context), nvidia/nemotron-3-nano-omni-30b-a3b-reasoning (vision),
//   nvidia/gpt-oss-120b, nvidia/gpt-oss-20b.
//   Down/redirected server-side (do NOT route to): nvidia/qwen3-next-80b-a3b-thinking
//   (NVIDIA EOL 2026-05-21, 410), nvidia/mistral-small-4-119b (timing out),
//   nvidia/deepseek-v3.2 + nvidia/glm-4.7 (NIM hung). Other retired-but-aliased:
//   nvidia/kimi-k2.5, nvidia/nemotron-{ultra-253b,3-super-120b,super-49b},
//   nvidia/mistral-large-3-675b, nvidia/devstral-2-123b, nvidia/qwen3.5-397b-a17b.
// ZAI (2): zai/glm-5, zai/glm-5-turbo
// MiniMax (2): minimax/minimax-m3 (flagship, 1M context, reasoning + coding), minimax/minimax-m2.7
// xAI (hidden, API-routable): xai/grok-4.20-reasoning, xai/grok-4.20-non-reasoning, xai/grok-4-fast-reasoning
export const MODEL_TIERS = {
  fast: ["google/gemini-3.5-flash", "google/gemini-2.5-flash", "google/gemini-3.1-flash-lite", "openai/gpt-5-mini", "deepseek/deepseek-chat", "google/gemini-3-flash-preview"],
  balanced: ["openai/gpt-5.5", "anthropic/claude-sonnet-4.6", "google/gemini-3.1-pro", "moonshot/kimi-k2.6", "openai/gpt-5.3", "openai/gpt-5.4"],
  powerful: ["anthropic/claude-opus-4.8", "openai/gpt-5.4-pro", "anthropic/claude-opus-4.7", "anthropic/claude-opus-4.6", "openai/o3", "openai/gpt-5.4"],
  cheap: ["zai/glm-5", "zai/glm-5-turbo", "nvidia/gpt-oss-120b", "nvidia/deepseek-v4-flash", "google/gemini-2.5-flash", "deepseek/deepseek-chat", "openai/gpt-5.4-nano"],
  reasoning: ["anthropic/claude-opus-4.8", "openai/o3", "openai/o1", "openai/o3-mini", "deepseek/deepseek-reasoner", "moonshot/kimi-k2.6", "openai/gpt-5.3-codex"],
  // 2026-06-07 sweep: dropped qwen3-next (NVIDIA EOL, 410), mistral-small-4-119b
  // (timing out), deepseek-v3.2 + glm-4.7 (NIM hung). All redirect server-side
  // anyway; these are the free models actually serving themselves.
  free: ["nvidia/llama-4-maverick", "nvidia/qwen3-coder-480b", "nvidia/deepseek-v4-flash", "nvidia/gpt-oss-120b", "nvidia/gpt-oss-20b"],
  coding: ["anthropic/claude-opus-4.8", "zai/glm-5", "openai/gpt-5.3-codex", "moonshot/kimi-k2.6", "nvidia/qwen3-coder-480b", "anthropic/claude-sonnet-4.6", "openai/gpt-5.4"],
  glm: ["zai/glm-5", "zai/glm-5-turbo"],
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

