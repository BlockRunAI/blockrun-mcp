# Changelog

All notable changes to BlockRun MCP will be documented in this file.

## 0.14.3

- **`feat(budget)` — pre-call budget gates on every paid tool.** Previously only `blockrun_chat` ran a budget check, and it recorded post-hoc, so a near-exhausted budget could be overshot by the last expensive call. Now image / music / video / search / exa / markets / price / modal / phone / surf all expose `agent_id` and pre-check the estimated cost against the global + per-agent limit before settling.
  - Per-tool cost estimates: image per-model, music flat $0.1575, video per-second × billed-duration, price per stocks tier, phone per-endpoint, exa per-URL for `contents`, markets/surf per-path tier
  - `checkBudget(budget, agent_id, estimatedCost)` compares `spent + cost` against `limit` with EPSILON-safe float math
- **`feat(wallet)` — chain-aware fail-fast for Base-only tools.** `blockrun_image`, `blockrun_music`, `blockrun_video`, and paid `blockrun_price` calls return a clear "Switch to Base" error before attempting to create or charge a Base wallet under Solana mode.
  - Free `blockrun_price` calls (crypto/FX/commodity/list) no longer require a wallet — new cached `_freePriceClient` uses `requireWallet: false`
  - `blockrun_wallet` action `budget`/`delegate`/`revoke`/`report` no longer reads or creates a wallet, so per-agent budget setup works before funding
- **`fix(tools)` — assorted correctness fixes.**
  - `blockrun_models` switches to `listAllModels` when available so image models appear in `category:"image"`; filter uses `type === "image"` instead of fragile substring match (`dall-e`/`flux`/`banana`)
  - `blockrun_image` default model no longer renders as `undefined`; edit mode restricted to `openai/gpt-image-1|2` (other models fail upstream)
  - `blockrun_price` `from: 0` no longer misjudged as missing (`!from` → `from === undefined`); validates `market` required when `category="stocks"`; zod `limit` tightened to int positive max 2000
  - `blockrun_chat` mode-routing path now passes `temperature` (was dropped)
  - `blockrun_markets` `body ? pmQuery : pm` → `body !== undefined` so falsy bodies don't silently downgrade to GET (matches `blockrun_surf`)
- **`fix(budget)` — tighter cost estimates for chat smart routing + surf wallet/* endpoints.**
  - `blockrun_chat routing:"smart"` now estimates by `routing_profile`: free=$0 / eco=$0.002 / auto=$0.01 / premium=$0.05 (was flat $0.001). Stops a single premium-profile call from overshooting a near-empty budget by 50×. `mode:"reasoning"`/`mode:"powerful"` also escalate to $0.01.
  - `blockrun_surf` cost estimator rewritten from `includes()` heuristic to a Set + prefix lookup keyed off the marketplace catalog. Catches all `wallet/*` T2 endpoints (5 paths were undercharged 5×), `exchange/depth|klines|funding-history|long-short-ratio`, `market/liquidation/*`, `market/onchain-indicator|price-indicator`, `prediction-market/polymarket/positions|activity`, `social/detail|ranking|smart-followers/history`, `token/dex-trades|holders|transfers`, `web/fetch`. Also catches `onchain/schema` as T3 (was undercharged 20×).
- **`docs(readme)` — env-vars section reflects 0.14.1's `.chain` precedence** and adds explicit "Base-only" note for media tools + paid stock price calls.

## 0.14.1

- **fix(wallet): respect `~/.blockrun/.chain` over stale Solana session.** Previously, the mere existence of `~/.blockrun/.solana-session` pinned the MCP to Solana — even when the user had explicitly switched chains by writing `base` to `~/.blockrun/.chain`. Voice calls and other paid actions would 400 on a wallet/chain mismatch with no obvious recovery short of deleting session files. New precedence in `getChain()`: explicit `.chain` (or `payment-chain` alias) wins, then `SOLANA_WALLET_KEY` env var, then `.solana-session` autodetect as a first-run fallback only.

## 0.14.2

- **BREAKING — `blockrun_x` removed.** AttentionVC partner integration retired. Callers depending on this tool will get tool-not-found and should switch to `blockrun_surf` (`social/user`, `social/tweets`, `social/tweet/replies`, `social/mindshare`) or `blockrun_search` with `sources: ["x"]`.
- **BREAKING — `blockrun_phone`, `blockrun_exa`, `blockrun_modal`, `blockrun_search` switched to path-based passthrough** matching the `blockrun_surf` / `blockrun_markets` pattern. Old shape `{ action, ... }` no longer accepted; new shape is `{ path, body }`.
  - Reduces tool description bytes ~14 KB (down from ~21 KB), letting LLMs spend more attention on the actual call
  - Full endpoint catalogs moved into per-tool skills (`skills/phone/SKILL.md`, `skills/modal/SKILL.md`, `skills/search/SKILL.md`, updated `skills/exa-research/SKILL.md`)
  - Adding new endpoints to any of these surfaces no longer requires an MCP release
- **`blockrun_phone` voice/call: `from` is now correctly documented as REQUIRED.** Upstream has always required it (must be a number your wallet owns from `phone/numbers/buy`) but the prior tool description marked it optional, causing silent 400s.
- **Error surfacing fix.** Gateway 400/422/5xx responses now include the upstream `message`, `hint`, and `missing_params` fields in the error text. Previously the SDK's `APIError` body was swallowed, leaving only bare `API error: 400` with no actionable detail. New helper `extractErrorMessage()` in `src/utils/errors.ts` walks `err.response` and surfaces structured fields.
- dist/index.js: 85.48 KB → 75.60 KB (-11.5%).

## 0.14.0

- **`blockrun_surf` — unified crypto data via Surf (asksurf.ai), 84 endpoints behind one tool.** Path-based passthrough mirrors `blockrun_markets`; adding new Surf endpoints no longer requires an MCP release.
  - CEX market data (16 exchanges), on-chain SQL (13 chains, 80+ ClickHouse tables), 100M+ labeled wallets, Polymarket + Kalshi side-by-side, social mindshare / CT intel, news, unified search, Surf-1.5 chat with citations
  - Tier 1 $0.001 / Tier 2 $0.005 / Tier 3 $0.02 — settles directly to Surf's Base treasury, no Surf account required from the caller
  - Tool description ≤ 20 lines; full 84-endpoint catalog moved to the new `surf` skill
- **`surf` skill.** Quick Decision Table covering ~50 most-reached endpoints, 7 worked examples (price reads, ClickHouse SQL, wallet-labels triage, PM comparison, Surf-1.5 chat with citations, social mindshare, macro stack), method-routing rule (`body` ⇒ POST, else GET), full catalog organized by category. 26 triggers cover the long tail (`on-chain sql`, `wallet labels`, `mindshare`, `etf flows`, `tokenomics unlock`, ...) so the skill fires without users naming "Surf" explicitly.
- **Marketplace claim → reality.** `/marketplace/surf` page (line 338) previously advertised `blockrun_surf`; the tool did not exist. Now it does.

## 0.13.0

- **`blockrun_markets` — Predexon v2 endpoints surfaced.** All v2 endpoints went live in production on 2026-05-07. The path-based passthrough was already routing correctly, but agents couldn't discover the new routes from the stale description.
  - Canonical Cross-Venue (T1): `markets`, `markets/listings`, `outcomes/:predexon_id` — unified data layer with cross-venue IDs across Polymarket, Kalshi, Limitless, Opinion, Predict.Fun. Filters: `?venue=`, `?status=`, `?category=`, `?league=`, `?event_id=`, `?pagination_key=`
  - Sports (T1): `sports/categories`, `sports/markets`, `sports/markets/:game_id`, `sports/outcomes/:predexon_id` — markets grouped by game with venue listings
  - Keyset pagination: `polymarket/markets/keyset` and `polymarket/events/keyset` — cursor-based traversal via `?pagination_key=`
  - Wallet Identity & Clustering (T2): correct routes for `polymarket/wallet/identity/:wallet` (GET), `polymarket/wallet/identities` (POST, bulk up to 200 — replaces retired `identities-batch`), `polymarket/wallet/:address/cluster` (GET) — fixes 3 previously-listed wrong paths
- **`prediction-markets` skill rewrite.** Added 4 sections for v2: Canonical Cross-Venue, Sports, Keyset Pagination, Wallet Identity & On-Chain Clustering (T2). Quick Decision Table now leads with the canonical cross-venue endpoints. New worked example: tracking a smart wallet's identity + cluster.

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
