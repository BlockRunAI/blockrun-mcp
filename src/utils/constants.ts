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

// Model catalogue, refreshed against the live GET /v1/models on 2026-08-12
// (91 models on BOTH chains; free tier re-probed the same day — see free[]).
// Prices below are $/M input / $/M output as the BASE gateway quotes them.
// Known chain drift on 2026-08-12, confirmed against both gateways' source:
// sol still quotes deepseek-chat/reasoner at $0.2/$0.4 (Base took DeepSeek's
// 2026-08-07 cut to $0.14/$0.28) and glm-5 at $0.6/$1.92 (Base took Z.AI's
// raise to $1/$3.2). Both are sol-side lag, flagged upstream — do not "fix"
// them here by averaging.
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
// OpenAI (27): gpt-5.6-sol ($5/$30, 1M, deepest reasoning), gpt-5.6-terra
//   ($2/$12, 1M — the balanced default; CUT from $2.5/$15), gpt-5.6-luna
//   ($0.2/$1.2, 1M, no reasoning; CUT from $1/$6), plus the 2026-08 "pro
//   reasoning mode" trio: gpt-5.6-sol-pro ($5/$30), gpt-5.6-terra-pro ($1/$6 —
//   deliberately HALF the standard Terra rate, per the gateway registry, not a
//   pricing bug), gpt-5.6-luna-pro ($0.1/$0.6). gpt-5.5 ($5/$30), gpt-5.5-pro
//   ($30/$180 — ties gpt-5.4-pro for priciest model served), chat-latest
//   (rolling ChatGPT alias, currently GPT-5.5 Instant, 128K, $5/$30),
//   gpt-5.4 ($2.5/$15), gpt-5.4-pro ($30/$180), gpt-5.3 / gpt-5.2 /
//   gpt-5.3-codex ($1.75/$14), gpt-5.2-pro ($21/$168), gpt-5.4-mini,
//   gpt-5-mini, gpt-5.4-nano, gpt-4.1{,-mini,-nano}, gpt-4o{,-mini},
//   o1 ($15/$60), o3 ($2/$8), o3-mini, o4-mini
// Anthropic (9): claude-opus-5 ($5/$25, 1M, 128k out — newest Opus,
//   step-change over 4.8 at the same price; live-probed 2026-08-12),
//   claude-opus-4.8 ($5/$25, 1M), claude-fable-5 ($10/$50, 1M),
//   claude-opus-4.7 ($5/$25, 1M), claude-sonnet-5 ($3/$15, 1M),
//   claude-opus-4.5, claude-sonnet-4.6, claude-sonnet-4.5, claude-haiku-4.5
// Google (9): gemini-3.1-pro ($2/$12), gemini-3.6-flash ($1.5/$7.5, thinking —
//   newest Flash), gemini-3.5-flash ($1.5/$9 — REPRICED from the $0.5/$3 this
//   file recorded in July), gemini-3-flash-preview ($0.5/$3),
//   gemini-3.5-flash-lite ($0.3/$2.5, live-probed 2026-08-12),
//   gemini-3.1-flash-lite ($0.25/$1.5), gemini-2.5-pro, gemini-2.5-flash,
//   gemini-2.5-flash-lite — all 1M context
// DeepSeek (3): deepseek-v4-pro ($0.435/$0.87, 1M, reasoning + coding),
//   deepseek-chat, deepseek-reasoner ($0.14/$0.28 on Base since DeepSeek's
//   2026-08-07 cut; sol still quotes $0.2/$0.4 — see the drift note above)
// Moonshot (1): kimi-k3 ($3/$15, 1M, vision + reasoning + coding)
// ZAI (4): glm-5.2 ($1.4/$4.4, 1M), glm-5.1 ($1.4/$4.4), glm-5 ($1/$3.2 —
//   Z.AI RAISED the list rate; still the cheapest ZAI, but no longer a
//   cheap-tier pick), glm-5-turbo ($1.2/$4)
// xAI (3): grok-4.5 ($2.5/$9, 500K, native search), grok-4.3 ($1.5/$4, 1M),
//   grok-build-0.1 ($1.5/$3, coding)
// MiniMax (2): minimax-m3 ($0.3/$1.2, 1M), minimax-m2.7 ($0.3/$1.2, 200K)
// Qwen (3): qwen3.7-max ($1.475/$4.425, 1M), qwen3.7-plus ($0.32/$1.28, 1M),
//   qwen3.7-flash ($0.03/$0.13, 1M — the cheapest PAID model in the catalogue;
//   live-probed 2026-08-12)
// Tencent (1): hy3 ($0.132/$0.528, 262K, reasoning; live-probed 2026-08-12)
// Xiaomi (1): mimo-v2.5-pro ($0.435/$0.87, 1M reasoning)
// NVIDIA — genuinely $0. Serving healthy on the 2026-08-12 probe (both chains,
//   realistic ~1.4K-token prompt): nemotron-3-nano-omni-30b-a3b-reasoning
//   (vision, ~1s), step-3.7-flash, mistral-nemotron (24.9s on sol — slowest
//   healthy entry, demoted in free[] order), nemotron-nano-9b-v2,
//   nemotron-nano-12b-v2-vl (vision).
//   Also live but UNLISTED (hidden from GET /v1/models, still served): gpt-oss-120b
//   — the gateway's own free fallback — and gpt-oss-20b (both re-probed
//   2026-08-12, ~0.6-2.5s, serving themselves).
//   DEAD SINCE THE JULY SWEEP, removed 2026-08-12: deepseek-v4-flash and
//   seed-oss-36b now report `"model": "nvidia/gpt-oss-120b"` on BOTH chains —
//   the aliasing trap from the note above, caught again. Keeping them routed
//   would just be a slower spelling of free[0]. mistral-large-3-675b (the
//   123s crawler) is gone from the catalogue entirely.
//   PROMOTED 2026-08-12: nemotron-3-nano-omni-30b-a3b-reasoning no longer
//   aliases on Base (it served itself in 0.97s; July saw it alias to
//   gpt-oss-120b there) — so the reason it was documented-but-unrouted is
//   gone, and it joins free[].
export const MODEL_TIERS = {
  fast: ["google/gemini-3.5-flash", "google/gemini-2.5-flash", "openai/gpt-5.6-luna", "google/gemini-3.5-flash-lite", "openai/gpt-5-mini", "deepseek/deepseek-chat", "google/gemini-3-flash-preview"],
  balanced: ["openai/gpt-5.6-terra", "anthropic/claude-sonnet-5", "moonshot/kimi-k3", "google/gemini-3.1-pro", "xai/grok-4.5", "openai/gpt-5.5"],
  powerful: ["anthropic/claude-opus-5", "anthropic/claude-opus-4.8", "openai/gpt-5.6-sol", "anthropic/claude-fable-5", "openai/gpt-5.4-pro", "openai/gpt-5.2-pro"],
  cheap: ["deepseek/deepseek-v4-pro", "qwen/qwen3.7-flash", "minimax/minimax-m3", "tencent/hy3", "google/gemini-2.5-flash", "deepseek/deepseek-chat", "openai/gpt-5.4-nano"],
  reasoning: ["anthropic/claude-opus-5", "anthropic/claude-opus-4.8", "openai/gpt-5.6-sol", "moonshot/kimi-k3", "xai/grok-4.3", "deepseek/deepseek-v4-pro", "deepseek/deepseek-reasoner"],
  // 2026-08-12 sweep (both chains, realistic prompt). Order matters: free[0]
  // is what every mode:"free" call tries first, and a slow primary stalls the
  // whole routing loop before it can fall through. Changes this sweep:
  // deepseek-v4-flash and seed-oss-36b REMOVED (both now alias to gpt-oss-120b
  // on both chains — dead, see the NVIDIA note above); nemotron-3-nano-omni
  // PROMOTED (no longer aliased on Base); mistral-nemotron demoted below
  // step-3.7-flash (24.9s on sol vs the 1.7-12s healthy band).
  //
  // DELISTED IS NOT DEAD. The previous pass dropped gpt-oss-120b and gpt-oss-20b
  // as "retired", reasoning that they only worked via server-side aliasing. That
  // was wrong, and the same sweep contained the disproof: llama-4-maverick was
  // observed "answering as gpt-oss-120b" — a model cannot be the alias TARGET and
  // be dead. Both are merely hidden from GET /v1/models; gpt-oss-120b is the
  // gateway's own FREE_FALLBACK_MODEL (and gpt-oss-20b its last-resort rung), so
  // it is the single most load-bearing free model there is. Re-probed 2026-07-21
  // on BOTH chains with a realistic ~1.5K-token prompt: gpt-oss-120b 3.5s,
  // gpt-oss-20b 3.7s; re-confirmed 2026-08-12 (0.6-2.5s, serving themselves).
  // Absence from the public catalogue is a listing decision, not a health
  // signal — check the behaviour. But the 2026-08-12 sweep also showed the
  // CONVERSE playing out: two other delisted entries (deepseek-v4-flash,
  // seed-oss-36b) turned out to be alias-dead, not hidden-alive. Delisting
  // tells you NOTHING either way; only the response's `model` field does.
  //
  // BEING LISTED IS NOT BEING ALIVE, EITHER — but state the failure accurately.
  // nvidia/mistral-large-3-675b (finally dropped from the catalogue by
  // 2026-08-12) did NOT hang. It CRAWLED. A toy ping ("say OK", 8 max_tokens)
  // returned in 2s, which is exactly how it kept re-certifying itself as
  // healthy; the same model on a realistic 1.5K-token prompt took 123.2s. That
  // is the trap the gateway's own probe script added a --real mode for. Never
  // health-check a free model with a 16-token ping.
  free: ["nvidia/gpt-oss-120b", "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning", "nvidia/step-3.7-flash", "nvidia/mistral-nemotron", "nvidia/gpt-oss-20b", "nvidia/nemotron-nano-12b-v2-vl", "nvidia/nemotron-nano-9b-v2"],
  coding: ["anthropic/claude-opus-5", "openai/gpt-5.3-codex", "moonshot/kimi-k3", "xai/grok-build-0.1", "zai/glm-5.2", "qwen/qwen3.7-max", "anthropic/claude-sonnet-5"],
  glm: ["zai/glm-5", "zai/glm-5.2", "zai/glm-5.1", "zai/glm-5-turbo"],
} as const;

export type RoutingMode = keyof typeof MODEL_TIERS;

/**
 * $/M input and output for every model a routing tier can resolve to, plus every
 * catalog model priced ABOVE the DEFAULT_CHAT_PRICE an explicit `model` falls
 * back to. Read off the live GET /v1/models on 2026-08-13.
 *
 * This exists because the budget gate used to reserve chat against two hardcoded
 * constants — "$5/M input" and "4 chars per token" — and BOTH were wrong at the
 * top of the catalog, in the same direction:
 *
 *   model                 charged (100k-char prompt)   old reserve   short by
 *   openai/gpt-5.4-pro            $1.460020             $0.147480      9.90x
 *   openai/gpt-5.5-pro            $1.460020             $0.147480      9.90x
 *   openai/gpt-5.2-pro            $1.026640             $0.147480      6.96x
 *   openai/o1                     $0.727420             $0.147480      4.93x
 *   anthropic/claude-fable-5      $0.486310             $0.147480      3.30x
 *   openai/gpt-5.6-sol            $0.244171             $0.147480      1.66x
 *   anthropic/claude-opus-5       $0.243655             $0.147480      1.65x   <- powerful[0]
 *   google/gemini-3.5-flash       $0.073951             $0.030072      2.46x   <- fast[0]
 *   zai/glm-5                     $0.049346             $0.030072      1.64x   <- glm[0]
 *
 * (Live unpaid 402 quotes, 2026-08-13. Every frontier model was under-reserved,
 * including the DEFAULT primary of mode:"powerful" — this is the same defect
 * class as the 11.4x under-reserve 0.32.3 was released to fix, which the comment
 * in chat.ts still describes as solved. It was solved only for the middle of the
 * price range.)
 *
 * Keep this in step with MODEL_TIERS: a tier member with no entry here reserves
 * DEFAULT_CHAT_PRICE, which is correct for everything at or below $5/$30 and
 * SHORT for the five models above it. `npm run verify:prices` probes one row per
 * tier against the live 402 so drift shows up as a failure, not as a surprise
 * invoice.
 */
export const CHAT_PRICE_PER_MTOKEN: Record<string, { input: number; output: number }> = {
  // Above the default — the five that made the gate unsafe. Reachable as an
  // explicit `model` as well as through powerful/reasoning.
  "openai/gpt-5.4-pro": { input: 30, output: 180 },
  "openai/gpt-5.5-pro": { input: 30, output: 180 },
  "openai/gpt-5.2-pro": { input: 21, output: 168 },
  "openai/o1": { input: 15, output: 60 },
  "anthropic/claude-fable-5": { input: 10, output: 50 },
  // At or below the default — listed so the CHEAP tiers reserve their own real
  // rate instead of the $5/$30 worst case, which would price a qwen3.7-flash
  // call like a frontier one and lock small budgets out of the cheap path.
  "anthropic/claude-opus-5": { input: 5, output: 25 },
  "anthropic/claude-opus-4.8": { input: 5, output: 25 },
  "anthropic/claude-opus-4.7": { input: 5, output: 25 },
  "anthropic/claude-opus-4.5": { input: 5, output: 25 },
  "anthropic/claude-sonnet-5": { input: 3, output: 15 },
  // The rest of the Anthropic family: in no tier, but every one of them is
  // reachable as an explicit `model` — and that path goes to the NATIVE
  // /v1/messages endpoint, where this table is also what reconstructs the ledger
  // entry (see anthropicCallCost). A missing id there books nothing at all.
  "anthropic/claude-sonnet-4.6": { input: 3, output: 15 },
  "anthropic/claude-sonnet-4.5": { input: 3, output: 15 },
  "anthropic/claude-haiku-4.5": { input: 1, output: 5 },
  "openai/gpt-5.6-sol": { input: 5, output: 30 },
  "openai/gpt-5.5": { input: 5, output: 30 },
  "openai/gpt-5.6-terra": { input: 2, output: 12 },
  "openai/gpt-5.3-codex": { input: 1.75, output: 14 },
  "openai/gpt-5-mini": { input: 0.25, output: 2 },
  "openai/gpt-5.6-luna": { input: 0.2, output: 1.2 },
  "openai/gpt-5.4-nano": { input: 0.2, output: 1.25 },
  "google/gemini-3.1-pro": { input: 2, output: 12 },
  "google/gemini-3.5-flash": { input: 1.5, output: 9 },
  "google/gemini-3-flash-preview": { input: 0.5, output: 3 },
  "google/gemini-2.5-flash": { input: 0.3, output: 2.5 },
  "google/gemini-3.5-flash-lite": { input: 0.3, output: 2.5 },
  "moonshot/kimi-k3": { input: 3, output: 15 },
  "xai/grok-4.5": { input: 2.5, output: 9 },
  "xai/grok-4.3": { input: 1.5, output: 4 },
  "xai/grok-build-0.1": { input: 1.5, output: 3 },
  "qwen/qwen3.7-max": { input: 1.475, output: 4.425 },
  "qwen/qwen3.7-flash": { input: 0.03, output: 0.13 },
  "zai/glm-5.2": { input: 1.4, output: 4.4 },
  "zai/glm-5.1": { input: 1.4, output: 4.4 },
  "zai/glm-5-turbo": { input: 1.2, output: 4 },
  "zai/glm-5": { input: 1, output: 3.2 },
  "deepseek/deepseek-v4-pro": { input: 0.435, output: 0.87 },
  "deepseek/deepseek-chat": { input: 0.14, output: 0.28 },
  "deepseek/deepseek-reasoner": { input: 0.14, output: 0.28 },
  "minimax/minimax-m3": { input: 0.3, output: 1.2 },
  "tencent/hy3": { input: 0.132, output: 0.528 },
};

/**
 * What an UNKNOWN explicit model reserves. $5/$30 is the ceiling of the catalog
 * excluding the five outliers above, so a model added upstream between releases
 * is covered unless it is priced in the pro tier — and those five are listed.
 */
export const DEFAULT_CHAT_PRICE = { input: 5, output: 30 } as const;

/**
 * Characters per input token, as the GATEWAY counts them for a quote.
 *
 * Measured 2026-08-13: a 100,000-character prompt quotes ~48,000 input tokens
 * across every model probed (2.08 chars/token). The estimator assumed 4, so it
 * halved the input bill before the price error even applied.
 *
 * It is a CHARACTER count on the gateway too, not a real tokenizer: the same
 * 100k chars of CJK and of ASCII quote the identical amount ($0.098269 on
 * gpt-5.6-terra), so this ratio holds across alphabets. Rounded DOWN to 2 —
 * fewer chars per token means more tokens means a larger reserve, the safe
 * direction.
 */
export const GATEWAY_CHARS_PER_TOKEN = 2;

/**
 * The MEASURED ratio, for reconstructing what actually settled.
 *
 * Same split as TRANSACTION_FEE_USD vs OBSERVED_GATEWAY_TX_FEE_USD, for the same
 * reason: a reserve should round against us, a ledger entry should be accurate.
 * Fitted from live quotes at 10k and 100k characters (2.075 and 2.083); using
 * the conservative 2 here would over-book every large prompt by ~4%.
 */
export const GATEWAY_CHARS_PER_TOKEN_OBSERVED = 2.08;

/**
 * The most expensive model each tier can settle at. Derived, not hand-written,
 * so adding a model to a tier cannot leave the gate reserving the old maximum.
 *
 * Worst-member (not first-member) is the right bound: the routing loop falls
 * through to a later model whenever an earlier one fails BEFORE taking payment,
 * so any member can be the one that settles.
 */
export const TIER_WORST_PRICE: Record<RoutingMode, { input: number; output: number }> =
  Object.fromEntries(
    (Object.keys(MODEL_TIERS) as RoutingMode[]).map((mode) => {
      const rates = MODEL_TIERS[mode].map(
        (id: string) => CHAT_PRICE_PER_MTOKEN[id] ?? (id.startsWith("nvidia/") ? { input: 0, output: 0 } : DEFAULT_CHAT_PRICE),
      );
      return [mode, {
        input: Math.max(...rates.map((r) => r.input)),
        output: Math.max(...rates.map((r) => r.output)),
      }];
    }),
  ) as Record<RoutingMode, { input: number; output: number }>;

/**
 * Per-model and whole-loop deadlines for the mode:"free" routing fallback.
 *
 * Free NVIDIA models do not fail by erroring, they fail by CRAWLING — the
 * measurement that got mistral-large-3-675b excluded was 2s on a toy ping and
 * 123.2s on a real 1.5K-token prompt. The SDK's default request timeout is
 * 600s, so before these bounds existed a single degraded entry could hold an
 * MCP tool call for ten minutes before the loop fell through to the next model,
 * and a fully degraded tier for seven times that.
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
 * The free NVIDIA path SILENTLY TRUNCATES the prompt at 131,072 CHARACTERS.
 *
 * CHARACTERS — not bytes, not tokens. 0.32.2 shipped this as a BYTE cap and was
 * wrong; 0.32.3 corrects it. The original sweep only ever probed ASCII, where
 * bytes and characters are the same number, so the two hypotheses were
 * indistinguishable. Re-probed 2026-07-21 with CJK, which separates them at 3
 * bytes per character:
 *
 *     ASCII  131,000 chars / 131,000 B -> prompt_tokens  16,440   intact
 *     ASCII  135,000 chars / 135,000 B -> prompt_tokens  16,443   capped
 *     ASCII  400,000 chars / 400,000 B -> prompt_tokens  16,443   capped, identical
 *     CJK     50,000 chars / 150,000 B -> prompt_tokens  50,065   INTACT
 *     CJK    131,000 chars / 393,000 B -> prompt_tokens 131,065   INTACT
 *     CJK    135,000 chars / 405,000 B -> prompt_tokens 131,043   capped
 *
 * A 393 KB CJK prompt passes through whole, so the limit cannot be on bytes.
 * 131,065 tokens is accepted while 16,443 is refused further input, so it is not
 * on tokens either. Both alphabets cap at the same ~131,072 characters.
 *
 * Why the direction of the error matters: UTF-8 byte length is always >= JS
 * string length, so a byte-based check can only ever OVER-fire. It never missed
 * a real truncation — it invented ones that never happened, bolting a
 * "⚠️ TRUNCATED" warning onto complete, correct answers for any non-ASCII prompt
 * (CJK, Cyrillic, Greek, Thai, emoji) and advising the caller to move to a PAID
 * model. That pushed agents off a working $0 path into real USDC spend on a
 * false premise, which is worse than the silence it was meant to fix.
 *
 * Still true and still the reason this exists: the truncation is invisible —
 * HTTP 200, confident well-formed answer, no error and no finish_reason signal,
 * with usage.prompt_tokens the only tell. And it is NOT a gateway-wide cap:
 * paid models scale linearly past it (the 402 quote for gpt-5.6-terra reads
 * ~12,016 input tokens at 25 KB and ~192,016 at 400 KB, no ceiling), so the
 * "1M context" noted against deepseek-v4-flash is unreachable on the free tier.
 *
 * Measure in JS string length (UTF-16 code units). Astral characters (emoji
 * beyond the BMP) count as 2, which errs toward warning slightly early — the
 * safe direction, and far smaller than the 3x error being corrected here.
 */
export const FREE_TIER_MAX_PROMPT_CHARS = 131_072;

export const BASE_TOKENS: Record<string, string> = {
  ETH: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
  WETH: "0x4200000000000000000000000000000000000006",
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  USDbC: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA",
  DAI: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb",
  cbETH: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22",
};

