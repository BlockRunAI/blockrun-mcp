# Changelog

All notable changes to BlockRun MCP will be documented in this file.

## 0.23.1

- **`fix(modal)` — long synchronous `sandbox/exec` no longer aborts at 60s and orphans a paid sandbox.** Modal's `exec` blocks until the command finishes (the skill documents `timeout` up to 1200s), but the call ran on the shared 60s-timeout client, so any exec over ~60s threw `AbortError` — the result was lost and the sandbox the user paid to create kept running upstream. Modal calls now use a dedicated client whose HTTP timeout is sized to the requested `timeout` (floored at the 300s sandbox default, capped at 30 min, plus slack), without lengthening the 60s timeout every other tool relies on.

## 0.23.0

- **`fix(budget)` — the spend cap now reflects REAL on-chain cost, not a flat estimate.** Paid tools recorded a pre-call estimate (a flat `$0.001` for explicit-model chat, a per-second table price for video) into the budget ledger instead of the amount actually settled via x402 — so a frontier-model chat or a 1080p/4K video could settle for orders of magnitude more than was booked, silently blowing past the cap the tool advertises. `blockrun_chat` now books the `LLMClient.getSpending()` delta (the SDK's real settled USDC) on every paid path; the manual-x402 media tools (`video`/`music`/`speech`/`realface`) record the 402 `details.amount`; native Anthropic derives cost from token usage. The pre-call gate is now `max_tokens`-aware so a near-exhausted budget can't authorize one large frontier completion, and `BLOCKRUN_BUDGET_LIMIT` sets an optional default global cap at startup (the ledger is still in-memory and resets per process). `blockrun_image` no longer over-charges sizes ≤1024² (the large-size tier only applies when a dimension truly exceeds 1024).
- **`fix(qr)` — a failed `sharp` install can no longer crash the whole server.** `sharp` was a top-level static import resolved before `main()`; on a fresh `npx` where the native binary fails to build (musl/Alpine, unusual arch, offline CI, partial optionalDeps) the entire module graph failed and *every* tool became unusable — for a cosmetic Solana payment-QR logo overlay. It now loads lazily and degrades to a (still scannable) logo-less QR when absent, and is declared an `optionalDependency`.
- **`fix(tools)` — passthrough routing, billing, error reporting, and the key-leak scanner.** An empty/whitespace `body` string now resolves to `undefined` (not `{}`), so `markets`/`phone`/`surf` no longer flip GET-only reads to POST or bill Tier-2 for a spuriously-empty body (and `rpc`'s method/body split is fixed). Top-level array/primitive responses are wrapped as `{ result }` for valid MCP `structuredContent` across `markets`/`search`/`exa`/`surf`/`modal`/`phone`. `markets`/`price` now surface the structured gateway error body; `blockrun_models` catches catalogue-fetch failures instead of throwing uncaught. The startup key-leak scanner also detects Solana secret keys exported as a 64-byte JSON array.
- **`chore` — require Node ≥ 20.19 and ship the skill catalogs.** `engines.node` now matches `@blockrun/llm` (≥20) and the documented `rpc-websockets`/`uuid` ESM constraint (Node 18 installed but crashed at runtime). The `skills/` directory now ships in the npm tarball so `npx` installs include the `SKILL.md` catalogs that tool descriptions point agents to.
- **`docs` — corrected stale model names, counts, prices, and install commands** across the tool descriptions, README, AGENTS.md, CONTRIBUTING.md, CLAUDE.md, and the image-prompting skill (real reasoning models, `$0.40` video clips, `blockrun_realface` in the Base-only list, 18-tool / 8-skill counts, valid Codex install, delisted DALL-E 3 / Flux references removed).
- **`test` — budget + body unit tests.** `test/budget.test.ts` proves the cap holds against real settled cost (with a regression guard showing the old flat-estimate path overshooting), and `test/body.test.ts` covers `coerceBody` (empty→undefined) and `asStructuredContent` array wrapping.

## 0.22.0

- **`feat` — tool profiles: `--profile media | trading | research | chat` (or `BLOCKRUN_MCP_PROFILE`) expose a trimmed tool set** so MCP clients load fewer schemas into context. One published package now serves focused installs — e.g. `npx @blockrun/mcp@latest --profile trading` registers 7 tools (`wallet price dex markets surf defi rpc`) instead of 18. `wallet` is in every profile, resources are gated to their tool, and an unknown name falls back to `full` (the historical 18-tool set, still the default when no flag is given). Thanks @KillerQueen-Z! (#20)
- **`test` — profile-resolution test suite + compile-time `ALL_TOOLS` drift guard.** New `npm test` (`tsx --test`) covers `--profile`/env precedence, case-insensitivity, per-profile tool counts, wallet-in-every-profile, and unknown→full fallback. `ALL_TOOLS` is now `as const satisfies readonly ToolName[]` with an exhaustiveness type guard, so a newly added tool can't silently drop out of the `full` profile.
- **`docs` — README links back to blockrun.ai/docs.** Thanks @VickyXAI! (#19)

## 0.21.5

- **`refactor` — internal cleanup, no behavior change.** Collapsed four byte-identical `fetchWithTimeout` copies (music, speech, video, realface) and the duplicated model-cache loader into shared `utils/http.ts` and `utils/model-cache.ts`. Both the abort timer and the model-cache TTL timer are now `.unref()`'d, so a pending request or expiring cache never keeps the stdio process alive. Added `isTimeoutError()` (checks the `AbortError`/`TimeoutError` DOMException name before falling back to message substrings) and used it for the music/speech/video timeout branches, replacing the previous inconsistent per-tool string matching.

## 0.21.4

- **`fix(wallet)` — pin `rpc-websockets@9.3.0` so the Solana wallet path loads on Node < 20.19 / < 22.** With the Solana deps now installed (0.21.3), a fresh install exposed a deeper transitive break: `@solana/web3.js@1.98.4` wants `rpc-websockets ^9.0.2`, which floats to `9.3.9` — and `9.3.9` bumped its `uuid` dependency to `^14.0.0`, which is **ESM-only**. `rpc-websockets` is CommonJS and does `require('uuid')`, so Node versions without `require(ESM)` support (e.g. 20.17) throw `ERR_REQUIRE_ESM` and `blockrun_wallet` crashes before returning. Declaring `rpc-websockets@9.3.0` (uuid `^8.3.2`, CJS) as a direct dependency pins the whole tree to one CJS-compatible copy that still satisfies `@solana`'s `^9.0.2` — npm `overrides` can't fix this because they're ignored when the package is installed as a dependency (the npx case). Verified: a clean tarball install resolves a single `rpc-websockets@9.3.0` with `uuid@8.3.2` and no ESM uuid anywhere in the tree.

## 0.21.3

- **`fix(wallet)` — declare `@solana/web3.js` + `@solana/spl-token` as direct deps so `blockrun_wallet` works on a fresh `npx` install.** Both are only `optionalDependencies` of `@blockrun/llm`, which npm installs *when they succeed* — so the wallet's Solana path (`ensureBothWallets` → `SolanaLLMClient.getBalance`) works in dev but a fresh `npx -y @blockrun/mcp@latest` that omits/fails optional deps shipped without them, throwing `missing dependency (@solana/web3.js)` on the default `status` action. Re-declared both at the ranges `@blockrun/llm` pins (`^1.98.4`, `^0.4.14`) so they install on every npx and dedupe to one copy — same pattern used for `@anthropic-ai/sdk` in 0.18.0.

## 0.21.2

- **`fix` — `--version`/`-v` and `--help`/`-h` CLI flags exit cleanly.** Metadata flags are now handled before the stdio transport connects, so version/help inspection no longer boots the full MCP server. Thanks @xianzuyang9-blip! (#16)
- **`fix(chat)` — stop recommending dead `nvidia/deepseek-v3.2` in the `blockrun_chat` description.** The 0.21.1 sweep rebuilt `MODEL_TIERS` but missed the tool description's direct-pick example, which still pointed at one of the NIM-hung models. Replaced with `nvidia/deepseek-v4-flash` (free, healthy, 1M context).

## 0.21.1

- **`fix(models)` — drop dead free models from `MODEL_TIERS`.** 2026-06-07 sweep: `free[]` led with `nvidia/qwen3-next-80b-a3b-thinking` (NVIDIA EOL, 410) and `nvidia/mistral-small-4-119b` (timing out), and included `nvidia/deepseek-v3.2` + `nvidia/glm-4.7` (NIM hung). Rebuilt `free[]` to the models actually serving themselves (`llama-4-maverick`, `qwen3-coder-480b`, `deepseek-v4-flash`, `gpt-oss-120b/20b`); `cheap[]` swapped `deepseek-v3.2` → `deepseek-v4-flash`; `glm[]` dropped the hung `nvidia/glm-4.7`.

## 0.21.0

- **`feat(defi)` — new `blockrun_defi` tool: DeFi fundamentals via DefiLlama.** Path-based GET passthrough to `/v1/defillama/*`: `protocols`, `protocol/{slug}`, `chains` (TVL), `yields` (APY pools) at $0.005/call and `prices/{coins}` at $0.001/call. Live-tested (ETH price round-trip).
- **`feat(realface)` — Virtual Portrait support.** New `action:"portrait"` enrolls an AI-generated character from an `image_url` in one step ($0.01, Base only, NO phone liveness — for fictional/AI characters; real people still go through the init→status→enroll liveness flow). `action:"list"` now returns both RealFace and Virtual Portrait assets. Live-tested end-to-end (generate → enroll → asset id usable with Seedance `real_face_asset_id`).

## 0.20.0

- **`feat(rpc)` — new `blockrun_rpc` tool: raw JSON-RPC on 40+ chains.** Path-based passthrough to the gateway's new Tatum-backed `/v1/rpc/{network}` endpoint (Ethereum, Base, Solana, Bitcoin, Sui, NEAR, XRP, Polkadot, Monad, Berachain, HyperEVM, and 30+ more). $0.002 per call; a JSON-RPC batch charges per element. Accepts `method`+`params` shorthand or a full JSON-RPC `body` (incl. batch arrays). Unknown-but-wellformed network slugs pass through, so new chains work without an MCP release. Full network catalog + per-chain recipes in the new `rpc` skill.
- **`fix(image)` — sync `blockrun_image` with the live catalog.** Removed delisted `openai/dall-e-3` (was the broken *default*) and `together/flux-schnell`; added `google/nano-banana-pro` ($0.10, up to 4K). Default model is now `openai/gpt-image-2` for both generate and edit. Corrected base prices (gpt-image-1 $0.02, gpt-image-2 $0.06 at 1024²; larger sizes billed higher) and made budget estimates size-aware. Edit (img2img) now also supports `google/nano-banana` and `google/nano-banana-pro`, matching the gateway's image2image roster. `size` is free-form (e.g. 1536x1024 for gpt-image-*, 4096x4096 for nano-banana-pro) instead of the stale DALL-E 1792px enum.

## 0.19.2

- **`docs` — retire the hosted `mcp.blockrun.ai` install.** The hosted HTTP server (a stale v0.2.x deployment with only 8 of 16 tools and the deprecated `X-Wallet-Key` hosted-auth flow) has been decommissioned. The npx stdio install is the only supported path: `claude mcp add blockrun -s user -- npx -y @blockrun/mcp@latest`. README on npm refreshed accordingly. No code changes.

## 0.18.0

- **`feat(chat)` — native Anthropic passthrough for `claude-*`: real `thinking` blocks + verbatim signatures.** An explicit `anthropic/claude-*` model now bypasses the OpenAI-compat `/v1/chat/completions` path and goes DIRECT to the gateway's native `/v1/messages` endpoint (via `@blockrun/llm`'s `AnthropicClient`), which forwards to `api.anthropic.com` verbatim — zero model substitution, no cost routing, no fallback. The OpenAI-compat path could not carry thought signatures (they're lost in conversion) and flattened thinking to a string; the native path returns the real Anthropic response untouched.
  - New `thinking` param (`{ type: "enabled", budget_tokens }`) — honored on the native `claude-*` path; `max_tokens` is auto-raised above `budget_tokens` when needed. Ignored for non-Claude models (no native thinking channel).
  - The tool result's `structuredContent` carries the verbatim native response: `native` (full Anthropic `Message`), `thinking_blocks` (with their original `signature`), `signature_present`, `requested_model` + the real upstream `model` echo (proof of no substitution), `stop_reason`, and `usage`. Nothing is fabricated.
  - **Multimodal image input** — `messages[].content` now accepts an array of `{ type: "text" }` / `{ type: "image_url" }` parts. Images (https URLs or `data:` base64 URIs) are converted to native Anthropic image blocks on the `claude-*` path, and forwarded verbatim for vision-capable models on the OpenAI path.
- **`chore(deps)` — add `@anthropic-ai/sdk` `^0.39.0`** as a direct dependency (previously only a transitive optional dep of `@blockrun/llm`), so the native passthrough path is always available to MCP consumers.

## 0.17.0

- **`feat(chat)` — `response_format` (JSON mode) and `stop` sequences on `blockrun_chat`.** The gateway now honors both OpenAI params on `/v1/chat/completions` — natively for OpenAI/Azure, and emulated for Anthropic/Bedrock (raw-JSON system instruction + code-fence strip for `response_format: "json_object"`; `stop` mapped to `stop_sequences`). Threaded through every routing path (smart, multi-turn, single-model, mode tiers).
- **`chore(deps)` — upgrade `@blockrun/llm` to `^2.11.0`** (from `^1.12.0`), which exposes the new `responseFormat` / `stop` options. Per the 2.x upgrade path, the dropped `"free"` routing profile is now coerced to default ClawRouter routing (the gateway already picks the most cost-effective model).

## 0.16.2

- **`feat(models)` — add `anthropic/claude-opus-4.8` to routing.** Anthropic's most capable Claude for complex reasoning and agentic coding ($5 in / $25 out, 1M context, 128k output, adaptive thinking, vision). Now leads the `powerful`, `reasoning`, and `coding` tiers in `MODEL_TIERS` so those modes route to it first, and it heads the Anthropic flagship roster in the catalog comment. The live `blockrun_models` catalog already serves it; this aligns the local routing hints.

## 0.16.1

- **`feat(models)` — add `google/gemini-3.5-flash` to routing.** Google's latest-generation Flash (built-in thinking mode, frontier-class quality at Flash speed; $0.5 in / $3 out, 1M context, vision + reasoning + coding). Now leads the `fast` tier in `MODEL_TIERS` so `mode:"fast"` routes to it first, and it's added to the Google model roster in the catalog comment. The live `blockrun_models` catalog already serves it; this aligns the local routing hints.

## 0.15.1

- **`docs(changelog)`** — clarify that the image-to-video price-tier correction applies to all image-input calls (seed `image_url` or `real_face_asset_id`), not just RealFace. No code change vs. 0.15.0; version bumped so the published package tracks the doc.

## 0.15.0

- **`feat(realface)` — new `blockrun_realface` tool + Seedance RealFace video.** BlockRun upgraded Seedance with BytePlus RealFace: enroll a real person once (liveness-verified) and generate video of *that specific person*, not a generic seed image. The MCP now exposes the full flow end-to-end:
  - `blockrun_realface action:"init"` (free) — creates an asset group and a phone H5 link; the link is rendered as a QR code and opened so the real person can scan it and complete the ~1 min liveness check (nod + blink). Pass `group_id` to refresh an expired link.
  - `blockrun_realface action:"status" group_id:…` (free) — polls until `ready_to_finalize:true`.
  - `blockrun_realface action:"enroll" name:… group_id:… image_url:…` (**$0.01 USDC, Base only**) — uploads the face photo, waits for the BytePlus face-match, returns the `ta_xxxx` asset id. Full x402 sign/verify/settle; settles only after the asset is active (group-not-active → 425, face-match-fail → 422, neither charges).
  - `blockrun_realface action:"list"` (free) — lists the wallet's enrolled `ta_xxxx` assets.
- **`feat(video)` — `blockrun_video` accepts `real_face_asset_id`.** Pass a `ta_xxxx` asset (Seedance 2.0 / 2.0-fast only) to drive real-person video. Mutually exclusive with `image_url`; client-side guardrails fail fast on model/conflict mismatches.
- **`fix(video)` — image-to-video now uses the correct (cheaper) price tier in the budget pre-check.** Any image-input call — seed `image_url` *or* `real_face_asset_id` — on Seedance 2.0 / 2.0-fast is now estimated at the image-to-video rate (`2.0-fast` $0.140/sec · `2.0` $0.183/sec) instead of the text-to-video rate (0.238 / 0.298). This matches the per-second rates already documented in the tool description and the upstream pricebook; previously image-to-video calls were over-estimated ~1.6×, making the pre-call budget gate stricter than reality. Affects only the client-side estimate — actual charges are set by upstream settlement. xAI and Seedance 1.5-pro image calls are unchanged.
- Privacy: BlockRun stores only the asset id, name, and the photo URL you supply — no face/liveness data.

## 0.14.5

- **`fix(video)` — Seedance prices realigned to upstream 720p + audio defaults.** The gateway's `/v1/videos/generations` route now defaults Seedance calls to `resolution: 720p` with `generate_audio: true` for t2v (commit `e6dc1f1` on the main app), which roughly doubles tokens/sec vs. the historical 480p baseline. MCP's per-second display rates and budget pre-check were still calibrated to the old 480p figures, so the pre-call budget gate was under-estimating Seedance cost by ~2× — a near-empty budget could overshoot. Rates and tool description bumped to match upstream's canonical pricebook:
  - `bytedance/seedance-1.5-pro`: $0.046/sec → **$0.092/sec** (720p + audio t2v)
  - `bytedance/seedance-2.0-fast`: $0.119/sec → **$0.238/sec** text · **$0.140/sec** image-to-video
  - `bytedance/seedance-2.0`: $0.149/sec → **$0.298/sec** text · **$0.183/sec** image-to-video
  - 2.0-fast / 2.0 Pro tool description now flags BytePlus RealFace asset support (see `/docs/video/real-person-ip` on the main app).
  - README $5-capacity headline updated: was "~20 Seedance 1.5-pro clips" (480p), now "~10 clips" (720p+audio).

## 0.14.4

- **`fix(search)` — pricing was wrong by ~3×.** Old `estimateSearchCost` multiplied `$0.025 × sources.length` so `sources: ["web","x","news"]` budgeted $0.075 — but upstream actually charges per *returned result*, not per source category. Now `$0.025 × max_results` (default 10 → $0.25, cap 50 → $1.25). Skill + tool description + README aligned.
  - Also rename body fields to match upstream snake_case: `maxResults`→`max_results`, `fromDate`→`from_date`, `toDate`→`to_date`. Tool/skill examples updated.
- **`fix(video)` — Seedance prices calibrated to upstream token billing.** Seedance is token-priced (token360) on the gateway, not flat per-second. Display rates updated:
  - `bytedance/seedance-1.5-pro`: $0.03/sec → **$0.046/sec** (was undercharging)
  - `bytedance/seedance-2.0-fast`: $0.15/sec → **$0.119/sec** (was overcharging)
  - `bytedance/seedance-2.0`: $0.30/sec → **$0.149/sec** (was overcharging 2×)
  - README $5 capacity now correctly reads "~20 Seedance 1.5-pro clips" (was 30).

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
