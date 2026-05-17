# Changelog

All notable changes to BlockRun MCP will be documented in this file.

## 0.14.0

- **`blockrun_surf` — unified crypto data via Surf (asksurf.ai), 84 endpoints behind one tool.** Path-based passthrough mirrors `blockrun_markets`; adding new Surf endpoints no longer requires an MCP release.
  - CEX market data (16 exchanges), on-chain SQL (13 chains, 80+ ClickHouse tables), 100M+ labeled wallets, Polymarket + Kalshi side-by-side, social mindshare / CT intel, news, unified search, Surf-1.5 chat with citations
  - Tier 1 $0.001 / Tier 2 $0.005 / Tier 3 $0.02 — settles directly to Surf's Base treasury, no Surf account required from the caller
  - Tool description ≤ 20 lines; full 84-endpoint catalog moved to the new `surf` skill
- **`surf` skill.** Quick Decision Table covering ~50 most-reached endpoints, 7 worked examples (price reads, ClickHouse SQL, wallet-labels triage, PM comparison, Surf-1.5 chat with citations, social mindshare, macro stack), method-routing rule (`body` ⇒ POST, else GET), full catalog organized by category. 26 triggers cover the long tail (`on-chain sql`, `wallet labels`, `mindshare`, `etf flows`, `tokenomics unlock`, ...) so the skill fires without users naming "Surf" explicitly.
- **Marketplace claim → reality.** `/marketplace/surf` page (line 338) previously advertised `blockrun_surf`; the tool did not exist. Now it does.

## 0.13.0

- **`blockrun_markets` tool description rewritten for Predexon v2.** All v2 endpoints went live in production on 2026-05-07; the tool spec was missing them and three previously-listed wallet endpoints had wrong paths. The generic `path`-based passthrough was already routing correctly, but agents couldn't discover the new routes from the description.
  - **New section: CANONICAL CROSS-VENUE (Tier 1)** — `markets`, `markets/listings`, `outcomes/:predexon_id`. Predexon v2 unified data layer with cross-venue IDs (Polymarket, Kalshi, Limitless, Opinion, Predict.Fun). Filter by `?venue=`, `?status=`, `?category=`, `?league=`, `?event_id=`, `?pagination_key=`.
  - **New section: SPORTS (Tier 1)** — `sports/categories`, `sports/markets`, `sports/markets/:game_id`, `sports/outcomes/:predexon_id`. Sports markets grouped by game with venue listings.
  - **Polymarket keyset pagination** — `polymarket/markets/keyset` and `polymarket/events/keyset` added alongside their non-keyset counterparts. Use `?pagination_key=` for cursor-based traversal of large result sets.
  - **WALLET IDENTITY & CLUSTERING (Tier 2) section** — replaces three incorrectly-pathed entries (`polymarket/wallet/identity`, `polymarket/wallet/identities-batch`, `polymarket/wallet/cluster`) with the correct routes: `polymarket/wallet/identity/:wallet` (GET), `polymarket/wallet/identities` (POST `{addresses: [...]}` up to 200 wallets — replaces the retired `identities-batch`), `polymarket/wallet/:address/cluster` (GET).
- **`prediction-markets` skill rewrite.** Added 4 new sections: Canonical Cross-Venue Markets (v2), Sports Markets (v2), Keyset Pagination (v2), and Wallet Identity & On-Chain Clustering (v2, Tier 2). Quick Decision Table now leads with the canonical cross-venue endpoints. New "Track a smart wallet's identity + cluster" workflow.

## 0.11.0

- **`blockrun_video` switches to async submit+poll**. The blockrun.ai video
  endpoint moved from sync to async on 2026-04-23. The tool now submits the
  job, then polls `/v1/videos/generations/{id}` with the same signed header
  every 5s until upstream returns `completed` (5min total budget). Tool input
  and output shapes are unchanged. Settlement only fires on the first completed
  poll, so upstream failure or budget exhaustion = zero charge.
- Bumped advertised `maxTimeoutSeconds` on video requests to 600s so the
  signed authorization stays valid across the polling window.

## 0.10.0

- **`blockrun_image` gains `openai/gpt-image-2`** (ChatGPT Images 2.0). Reasoning-driven generation with multilingual text rendering and character consistency. Added to the model `z.enum` so agents can pick it; edit-path default switched from `gpt-image-1` → `gpt-image-2` (gpt-image-1 still accepted). Description paragraph lists the new model at $0.06-0.12.
- **`blockrun_video` gains 3 ByteDance Seedance variants**:
  - `bytedance/seedance-1.5-pro` — $0.03/sec, 5s default (up to 10s), cheapest path.
  - `bytedance/seedance-2.0-fast` — $0.15/sec, ~60-80s gen, sweet-spot price/quality.
  - `bytedance/seedance-2.0` — $0.30/sec, 720p Pro quality.
  Added to the model `z.enum`; `duration_seconds` description now covers 5s Seedance default + 10s ceiling. Timeout error message de-xAI-ified.
- **Dep bump**: `@blockrun/llm` `^1.8.0` → `^1.9.0` to match the types widened for the new image edit models.

## 0.9.2

- **`MODEL_TIERS` now matches the post-refresh NVIDIA free tier.** The 0.9.1 note claimed "no code change was required" — that was wrong for `blockrun_chat` with `mode: "free"` or `mode: "coding"`, which picks the primary model from the hardcoded tier list rather than the live catalogue. The stale list still put retired models at positions 2–3 (`nvidia/nemotron-ultra-253b`, `nvidia/nemotron-super-49b`) and kept `nvidia/devstral-2-123b` in `coding`. The backend redirected, so requests didn't fail, but the two new fast models (`nvidia/qwen3-next-80b-a3b-thinking`, `nvidia/mistral-small-4-119b`) were never primary picks.
- `mode: "free"` now leads with `nvidia/qwen3-next-80b-a3b-thinking` → `nvidia/mistral-small-4-119b`, then the 6 other visible free models.
- `mode: "coding"` drops the retired `nvidia/devstral-2-123b`.
- Provider-summary comment block refreshed: Anthropic section lists the current flagships (opus-4.7 / opus-4.6 / sonnet-4.6 / haiku-4.5), NVIDIA section describes the 8 visible models + which retired IDs the backend still aliases.

## 0.9.1

- **Install command:** `claude mcp add blockrun -s user -- npx -y @blockrun/mcp@latest` (the `-s user` scope fixes a per-project install pitfall the previous command caused).
- NVIDIA free-tier refresh on the backend (2026-04-21): retired `nvidia/nemotron-*`, `nvidia/mistral-large-3-675b`, `nvidia/devstral-2-123b`, `nvidia/qwen3.5-397b-a17b`, and paid `nvidia/kimi-k2.5`. Two new models callable via `blockrun_chat`: `nvidia/qwen3-next-80b-a3b-thinking` (free reasoning flagship) and `nvidia/mistral-small-4-119b` (fastest free chat). `blockrun_models` returns the current catalogue live, so no code change was required.

## 0.9.0

- **New `blockrun_price` tool** — Pyth-backed realtime quotes and OHLC history across crypto, FX, commodities and 12 global stock markets (us/hk/jp/kr/gb/de/fr/nl/ie/lu/cn/ca). Crypto / FX / commodity are fully free; stocks charge $0.001 per call. Actions: `price`, `history`, `list`.
- **New `blockrun_x` tool** — structured X/Twitter access via the AttentionVC `/v1/x/*` endpoint family. Replaces the earlier Grok-chat prototype with 11 actions: `user_lookup`, `user_info`, `followers`, `followings`, `verified_followers`, `user_tweets`, `user_mentions`, `tweet_lookup`, `tweet_replies`, `tweet_thread`, `search`.
- Upgrade `@blockrun/llm` to `^1.8.0` for `PriceClient` + extended type metadata.

## 0.8.0

- **New `blockrun_video` tool** — generate short AI videos via `xai/grok-imagine-video` ($0.05/sec, 8s default). Text or image-to-video. Blocks until the clip is ready (~30-120s).
- `blockrun_image` now supports `xai/grok-imagine-image` ($0.02) and `xai/grok-imagine-image-pro` ($0.07).
- Tool responses surface the gateway-hosted permanent URL; source URLs and `backed_up` flag included when the asset was mirrored.

## 0.6.8

- Latest stable release
- Real-time data tools: markets, research, X/Twitter, crypto
- x402 micropayments via USDC
- MCP protocol compatible with Claude Code
