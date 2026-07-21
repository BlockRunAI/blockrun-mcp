# Changelog

All notable changes to BlockRun MCP will be documented in this file.

## 0.32.4

The second half of the 0.32.3 audit: the structural gap behind five of its
pricing bugs, plus the remaining "reported as fact, never verified" defects.

- **`fix(verify-prices)` — the gate now covers PARAMETERIZED routes.** Every
  pricing defect the audit found was on a route whose price depends on an
  *argument*, and `verify:prices` covered the flat routes exactly (20/20) and
  none of those. That was the single structural finding behind five separate
  bugs. It now probes image sizes per model, exa per-URL counts, and chat with a
  100k-character prompt — **28 routes, 0 under-reserving**. Probes may declare
  `allowOver` where a conservative reserve is the design (chat cannot know which
  model a tier settles on), but under-reserving still fails the release.
- **`fix(image)` — a 2048 render was billed at the 4096 price.** The large-size
  tier was a single `>1024` rule for every model. Probed live, `nano-banana-pro`
  charges **$0.107001 at both 1024 and 2048** and only steps to **$0.159500 at
  4096** — so a 2048 render over-reserved by 49% *and*, on the Base path where
  the estimate is written to the ledger verbatim, over-**booked** it permanently.
  Thresholds are now per-model.
- **`fix(polymarket)` — two "stated as fact, never checked" reports.** An RPC
  failure was coerced to `$0.00` and printed as "your Base wallet holds $0.00
  USDC — top up first" to a user holding $200; it now refuses to fund blind. And
  any non-403 from the CLOB — 502, 404, 429 from a misconfigured host — rendered
  as "✅ Region: order placement permitted" + "🎯 Ready to trade", cached 10
  minutes, so the user funded before the first buy failed; only 400/401/422 (what
  a *working* CLOB returns for an empty body) now count as permitted.
- **`fix(polymarket)` — a redeem with an unreadable balance no longer looks
  paid.** When the pUSD read failed, `paidOut` went null, which also made the
  "paid $0 while holding a winner" guard unreachable — and the success message
  simply omitted the payout line, rendering identically to a verified payout.
  That is the size=0 silent-loss shape this module was rewritten to kill. It now
  says the payout is UNVERIFIED and exposes `payoutVerified` in structured output.
- **`fix(realface)` — a failed portrait lookup claimed "none enrolled".** The
  RealFace half surfaced its own failure; the Virtual Portrait half collapsed to
  an empty list and prompted a duplicate $0.01 enroll of an asset that already
  existed.
- **`fix(polymarket)` — two of three Polygon RPCs were dead.** Probed with a real
  `eth_call`: llamarpc fails DNS, polygon-rpc.com returns 401 "tenant disabled",
  and 1rpc is rate-limited. `fallback()` depth was effectively 1 while ~9 reads x
  4 retries piled onto one throttled endpoint. Now publicnode + drpc + 1rpc, all
  verified live. The comment claiming the list is "read-only" is also gone —
  `POLYGON_RPC_URLS[0]` is the sole un-fallbacked transport for every *signing*
  client, so reordering it is a write-path change.
- **`fix(chat)` — `mode:"free"` built two clients and used one.** The eager
  `buildClient()` was dead on the only shape that reaches the routing loop; on
  Solana it re-ran `loadSolanaWallet()`'s home-directory scan every call.
- **`docs` — tool descriptions quoted pre-fee bases.** The description is the
  only pricing an LLM sees at call time, and it disagreed with both the reserve
  logic and the skills (which commit `ff32cb4` had already corrected). Exa and
  DefiLlama rows now quote the charged price. README's Surf endpoint count was
  84; code and the skill catalog both say 83.
- 207 tests, typecheck, build and `verify:prices` (28/28) green.

## 0.32.3

A multi-agent audit of 0.32.2 across nine angles, every finding put through two
independent skeptics. It caught nine real defects — including one in 0.32.2's own
headline fix. The nastiest is not a money bug: **an optional dependency could kill
the entire server.**

- **`fix(server)` — a missing `sharp` took down all 19 tools.** `sharp` is an
  `optionalDependency`, but `inline-image.ts` imported it at the top level, so ESM
  resolution failed before `main()` ran. Reproduced: with sharp absent,
  `node dist/index.js --version` exits **1** with `ERR_MODULE_NOT_FOUND` and empty
  stdout — for a preview feature that is **off by default**, on profiles that never
  register `blockrun_image`. A fresh `npx -y @blockrun/mcp@latest` hits it on musl,
  unusual arch, offline CI or `--no-optional`. No dev machine ever saw it, because
  every dev machine has sharp built. `qr.ts` documents this exact hazard and loads
  lazily; this module now does too. Verified after the fix: `--version` returns
  `0.32.3` and `tools/list` returns all 19 tools with sharp removed.
- **`fix(chat)` — 0.32.2's truncation cap was measured in BYTES; the gateway caps
  CHARACTERS.** The original sweep only probed ASCII, where the two are the same
  number. CJK separates them: **131,000 CJK characters (393,000 bytes) pass through
  whole** (`prompt_tokens 131,065`), and both alphabets cap at ~131,072 characters.
  Because UTF-8 length is always >= string length, the byte check could only
  **over**-fire — it never missed a real truncation, it invented ones, bolting
  "⚠️ TRUNCATED … only the first ~87%" onto complete, correct answers for any
  non-ASCII prompt and advising the caller to switch to a **paid** model. It pushed
  agents off a working $0 path into real USDC spend on a false premise, which is
  worse than the silence it was meant to fix. The test that pinned the wrong
  behaviour is now inverted.
- **`fix(security)` — SSRF guard was literal-only; wildcard DNS walked through it.**
  `127.0.0.1.nip.io` is a public name that resolves to loopback, and was verified
  end-to-end reading a local server and base64ing the body into the data URI sent
  onward to the gateway; `169.254.169.254.nip.io` reaches cloud metadata the same
  way. No redirect needed, so the per-hop literal check saw nothing suspicious.
  Hostnames are now resolved and **every** returned address is checked, failing
  closed on NXDOMAIN.
- **`fix(budget)` — two reserve bypasses.** `blockrun_exa` matched the raw path, so
  `contents?x=1` missed the per-URL branch: 100 URLs reserved **$0.012** and settled
  **$0.202** (17x), booked wrong permanently. And `estimateChatCost` ignored input
  entirely — a 100k-word prompt settled **$0.2557** against a **$0.0225** reserve
  (11.4x), with break-even at ~15 KB, an ordinary pasted file. Both now priced.
- **`fix(wallet)` — running `blockrun_wallet` flipped the chain Base → Solana.**
  `ensureBothWallets()` (the *default* status action) writes `.solana-session`, and
  chain autodetect keys off that file existing. Afterwards every paid tool signs
  from a zero-balance Solana wallet or refuses "Base-only" — including
  `action:"deposit"`, so the funding path itself became unreachable. Reproduced in a
  clean HOME; the chain is now pinned across provisioning.
- **`fix(polymarket)` — a reverted pUSD transfer reported success.** viem does not
  throw on revert; the receipt was discarded, so a failed withdrawal still printed
  "✅ Withdrawal submitted … the bridge delivers USDC to Base". `redeem.ts` and
  `setup.ts` both assert `receipt.status`; this path now does too.
- **`fix(ci)` — the 0.32.2 tag/release automation had two holes.** The step had no
  version-changed guard, so a `publish.yml`-only push or `workflow_dispatch` would
  tag HEAD and title the release from an unrelated commit. And `actions/checkout`
  fetches no tags, so the "tag exists" check always missed and the push ran
  unconditionally — failing the job *after* npm had already published. Now gated on
  the version diff and checked against `git ls-remote`.
- **`docs` — the README advertised $0.0075 for `blockrun_markets`/`blockrun_surf`;
  both charge $0.0095.** A 27% understatement of real money in the most-read file,
  and "$5 covers ~5,000 market queries" was 9.5x off (~525). Five lines corrected.
- 204 tests, typecheck, build and `verify:prices` (20/20 exact) green.

## 0.32.2

The free tier throws away everything past 128 KiB and returns `200` as if it
hadn't. This release makes that visible, and settles the one model 0.32.1 left
documented-but-unexplained.

- **`fix(chat)` — the free tier silently truncates at 128 KiB; `blockrun_chat`
  now says so.** Measured against the live gateway: `usage.prompt_tokens`
  flatlines at **26,266** for every request body from 135,000 B upward —
  identical on `gpt-oss-120b` and `deepseek-v4-flash`, so it is a property of the
  free path, not of one model's context window. There is no error, no warning and
  no `finish_reason` signal; the reply is confident and well-formed, which makes
  this the worst failure shape available — **indistinguishable from success**. An
  agent summarising a large document over `mode:"free"` would present an answer
  about the first 128 KiB as an answer about the whole thing. Oversized free calls
  now come back with how large the prompt was, how much was discarded, and what to
  use instead, plus `truncated: true` in `structuredContent`. Verified end to end:
  on a 176 KiB prompt the warning predicts 73% kept and the gateway counted 73%.
  Sizing is in **bytes, not characters** — 128 KiB is only ~43K CJK characters, so
  counting characters would under-report by 3x and miss exactly the prompts that
  need warning.
- **Paid models are deliberately never warned about.** They do not truncate: the
  402 quote for `gpt-5.6-terra` scales linearly from ~12,016 input tokens at 25 KB
  to ~192,016 at 400 KB with no ceiling. (Read from the payment-required header, so
  measuring this cost nothing.) Consequence worth stating: the "1M context" noted
  against `deepseek-v4-flash` is **unreachable on the free tier**.
- **`docs(models)` — `nemotron-3-nano-omni-30b-a3b-reasoning` stays out of
  `free[]`, and now says why.** 0.32.1 listed it as healthy and free while leaving
  it unrouted with no reason given. It is healthy — and on Base it is **aliased**:
  it answers `200` in 2.0s while reporting `"model": "nvidia/gpt-oss-120b"`. On sol
  it serves itself (3.8s). Routing to it on Base would be a slower path to
  `gpt-oss-120b`, which is already `free[0]`. This is the aliasing trap described
  at the top of `constants.ts` caught in the act.
- 185 tests, typecheck, build and `verify:prices` (20/20 exact) green.

## 0.32.1

A correction to 0.32.0, which dropped two working models from the `free` tier on a
conclusion its own release notes disproved one paragraph earlier.

- **`fix(models)` — `gpt-oss-120b` and `gpt-oss-20b` are back in `free`; they were
  never retired.** 0.32.0 removed them as "delisted... the tier only ever worked
  through aliasing", but the same entry states that `llama-4-maverick` "answers
  `200 OK` while being served by `gpt-oss-120b`". A model cannot simultaneously be
  the thing serving the alias and be dead. They are hidden from `GET /v1/models`,
  which is a listing decision, not a health signal — and `gpt-oss-120b` is the
  gateway's own `FREE_FALLBACK_MODEL`, with `gpt-oss-20b` as its last-resort rung,
  making them the most load-bearing free models there are. Re-probed on **both**
  chains with a realistic ~1.5K-token prompt: `gpt-oss-120b` **3.5s**,
  `gpt-oss-20b` **3.7s**, both `200` with real completions. `gpt-oss-120b` is now
  `free[0]` — it is marginally faster than the outgoing `deepseek-v4-flash` (3.8s)
  and is what the gateway itself falls back to.
- **`fix(models)` — `mistral-large-3-675b` stays excluded, but for the right
  reason.** 0.32.0 recorded it as hanging: "no response, no error, connection held
  open past 90s". It does not hang. It **crawls**, and the distinction is the whole
  lesson: a toy ping (`"say OK"`, 8 `max_tokens`) comes back in **2s**, which is
  exactly how it kept certifying itself healthy, while the same model on a
  realistic 1.5K-token prompt took **123.2s**. That is why the gateway's own probe
  script has a `--real` mode. Never health-check a free model with a 16-token ping.
- **No tier churn.** The tiers now hold 39 unique IDs. 37 were re-diffed against
  live `GET /v1/models`: 0 missing, 0 dead. The other 2 are the deliberately
  unlisted `gpt-oss` pair above, which by definition cannot be confirmed that way
  and were confirmed by live probe on both chains instead. The catalogue side of
  0.32.0 was correct; only the free-tier reasoning was not.
- **`fix(chat)` — `mode:"free"` can no longer stall a tool call for eighty
  minutes.** The fallback loop had no deadline of any kind and the SDK's default
  request timeout is **600s** (not the 60s a comment in `wallet.ts` claimed — it
  was wrong by 10x, now corrected). Free models fail by *crawling*, so one
  degraded entry held the whole call for ten minutes before falling through, and
  a degraded tier for eight times that — a worst case this release made 33%
  longer by growing `free[]` from 6 entries to 8. The free path now builds its
  client with a 60s per-model timeout (~5x margin over the slowest healthy
  measurement) plus a 150s deadline on the **whole** loop, so adding a ninth free
  model can never lengthen the worst case again. Paid tiers are untouched: a
  multi-minute frontier completion is the job, not a fault. Exhausting the
  deadline now returns "the free tier did not answer" instead of blaming
  whichever model happened to be slowest.
- **`test` — the invariant behind the `$0` reserve is now pinned.**
  `estimateChatCost` returns `0` for `mode:"free"` purely because every `free[]`
  entry happens to be `nvidia/*`. That was an unenforced rule on a hand-edited
  array rewritten in three consecutive releases; one paid model landing in it
  would switch the budget gate off silently with every test still green. Added
  assertions for nvidia-only, non-empty and duplicate-free tiers, plus behavioural
  coverage of the new deadline. Both were mutation-tested (injecting
  `openai/gpt-5.6-sol` into `free[]`, and disabling the deadline check) to confirm
  they fail when violated.
- **Docs.** `README.md` still advertised Kimi K2.6, which 0.32.0 removed from the
  catalogue. The root `VERSION` file had been stuck at 0.30.1 since that release;
  it is read by nothing (`src/index.ts` takes the version from `package.json`) but
  it is misleading to read, so it now tracks `package.json`.
- 177 tests, typecheck and build green. `verify:prices` is 20/20 exact too, but
  it probes the paid surf/pm/modal/search/phone/exa/rpc routes and contains no
  chat route — it carries no signal about the free tier, and the model claims
  above rest on the live probes rather than on it.

## 0.32.0

Kimi K3 and the current high-end lineup, plus the tier lists rebuilt against the live catalogue instead of edited by hand. The interesting part is why nobody noticed they had rotted: **a retired model ID does not fail.** The gateway silently aliases it onto something else — `nvidia/llama-4-maverick` answers `200 OK` while being served by `gpt-oss-120b`, and `moonshot/kimi-k2.6` still quotes a price. Only a wholly unknown ID `400`s. So "it works" was never evidence a tier was correct, and 8 dead IDs had accumulated across 6 tiers.

- **`feat(models)` — `moonshot/kimi-k3` ($3/$15, 1M ctx, vision + reasoning + coding)** added to `balanced`, `reasoning`, and `coding`. It supersedes the whole k2.x line, which is gone from the catalogue — `kimi-k2.6` was still listed in three tiers and was being aliased somewhere unchosen on every hit.
- **`feat(models)` — the current high end, none of which we served.** `gpt-5.6-sol` ($5/$30, 1M) and `gpt-5.6-terra` ($2.5/$15, 1M); `claude-sonnet-5` ($3/$15, 1M) and `claude-fable-5` ($10/$50, 1M); `grok-4.5` ($2.5/$9, native search), `grok-4.3` ($1.5/$4, 1M) and `grok-build-0.1` (coding); `qwen3.7-max`; `deepseek-v4-pro` ($0.435/$0.87, 1M — frontier-class reasoning at budget-tier pricing, now `cheap[0]`); `minimax-m3`; `glm-5.2`/`glm-5.1`.
- **`feat(chat)` — the default model is now `openai/gpt-5.6-terra`.** `balanced[0]` is what every call with no `model` resolves to. Newer line, 1M context, and **half the price** of the outgoing `gpt-5.5` default ($2.5/$15 vs $5/$30).
- **`fix(models)` — the `free` tier was 4/5 retired.** `llama-4-maverick`, `qwen3-coder-480b`, `gpt-oss-120b` and `gpt-oss-20b` are all delisted; the tier only ever "worked" through the aliasing above, i.e. free calls were being served by a model nobody picked. Rebuilt from the `$0` models the catalogue actually lists.
- **`fix(models)` — being listed is not being alive; every entry was live-probed.** `nvidia/mistral-large-3-675b` is in the catalogue at `$0` and **hangs**: no response, no error, connection held open past 90s, reproduced twice. It had landed at `free[0]` on the first pass — the first model every `mode:"free"` call tries — where it would have stalled the routing loop before it could fall through. Excluded and documented.
- **`docs(chat)` — the tool description no longer advertises the old tiers.** It still told the model `mode:"coding"` meant "GLM-5 first" when `coding[0]` had been `claude-opus-4.8` for several releases, and pointed `mode:"reasoning"` at `o1`. Modes, examples and the `model` hints now match what the tiers actually contain.
- **Budget gate re-verified, not assumed.** Adding $180/M and $168/M models raises the question of whether the `$20/M` frontier reserve still covers the worst case. It does — the gateway quotes sublinearly, so `gpt-5.4-pro` at 128k `max_tokens` quotes **$2.42** against a **$2.56** reserve — but headroom is only ~5%, so the constant was left alone rather than guessed at. Cheap-tier candidates probed the same way, all with wide margins.
- All 49 tier IDs validated against live `GET /v1/models`. 169 tests, typecheck, build, `verify:prices` (20/20 exact), and the stdio smoke test (19 tools) green.

## 0.31.6

Round 3. Two of these were live the whole time and invisible to every prior round: a skill that never loaded, and an endpoint that never existed. Both were found by asking the gateway instead of reading our own files.

- **`fix(skills)` — `prediction-markets` has never once loaded.** Its description read `...you CANNOT get from a public API: historical price...`. A plain YAML scalar may not contain `": "`, so the frontmatter failed to parse, the loader got no `name`, and the skill was never registered. It builds, it publishes, the prose reads perfectly — the only symptom is that Claude never uses a capability we shipped. Quoting the scalar fixes it; a new test parses every `SKILL.md` with a real YAML parser (a naive split would have "parsed" the dead file happily, which is the whole point).
- **`fix(surf)` — advertised an endpoint that does not exist.** `chat/completions` ("Surf-1.5 chat with citations", `$0.02 flat`) returns **404 Unknown Surf endpoint**; the gateway replies with its own catalog of **83**. That phantom *was* the off-by-one — `surf.ts` claimed 84 where the skill and the gateway both say 83. Told to use it, the model would have burned a turn on a 404.
- **`fix(pricing)` — `withTxFee` rounded where the gateway ceils.** `usdToMicroUsdc` is an unconditional `Math.ceil`. Rounding agrees only when the addition is exact and goes one micro short wherever the ×1.05 margin drifts in float: modal's CPU hour charges **102001** micro, not 102000. My own `.toFixed(4)` had been hiding it — `$0.102001` prints as `$0.1020`.
- **`fix(pricing)` — a prototype key killed every budget cap.** modal's GPU tables were object literals, so `TABLE["toString"]` resolved up the prototype chain to a **function**, `?? default` never fired, and it reached the gate as **NaN** — where `cost > 0` is false (so the call is **allowed**) and `spent += NaN` sticks for the life of the process. A $1-capped agent was cleared for a $500 call. Now `Map`s; `budget.ts` also fails closed on any non-finite estimate rather than let one estimator poison the ledger.
- **`docs(skills)` — every stale price corrected against live quotes.** All in the same direction, always understating: `image-prompting` nano-banana **~$0.01 → $0.0545** (5.45×) and a gpt-image-2 poster **~$0.04 → $0.128** (3.2×, the >1024 large tier); `surf` **$0.001 → $0.0095** (9.5×) plus a worked example still doing retired-tier math; `modal`'s A100 example quoted **no price at all** and claimed the sandbox "auto-evicts after 1200s idle" — it does not, it is **$1.3413** charged upfront and never refunded; `rpc` **$0.002 → $0.0040**; `exa` **$0.01 → $0.0120**; `phone` **$0.54 → $0.5420**; `search` `max_results:20` **$0.50 → $0.527**; `gentech` 14 figures including a budget split across `surf T1/T2` tiers that no longer exist; and `crypto-data` documented `blockrun_rpc({ chain: ... })` when the param is `network` — the call as written could not have run.
- **`test` — `npm run verify:prices`, a live gate against exactly this drift.** Probes all 20 paid routes and compares each 402 quote to what the estimator reserves; under-reserving exits non-zero, over-reserving warns. Free to run (no payment attached). This class of bug is invisible to CI by construction — the gateway reprices without an MCP release — and has now shipped **three times**: stale Surf tiers, the base mistaken for the charge, and round-vs-ceil. Reintroducing the classic bug trips it immediately. **All 20 routes now match the gateway exactly, to the micro-dollar.**
- 169 tests, typecheck, build green.

## 0.31.5

Round 2 of the audit loop — regression-hunting round 1's own fixes. Everything functional held; the only casualties were artifacts of my own regex surgery in 0.31.4.

- **`fix(skills)` — the surf rewrite left the file inconsistent.** Deleting the `chat/completions` section with a regex (rather than by hand) left: worked-example headings numbered **1, 2, 3, 4, 6, 7** with a hole where 5 had been; an **empty `### Chat — 1` category heading** whose only endpoint 404s; and a catalog claiming **83 endpoints / 13 categories** while the per-category counts still summed to **84**. Renumbered, orphan removed, counts reconciled — 12 categories summing to 83, matching the header.
- **Verified no functional regression from the 0.31.2–0.31.4 fixes.** Every genuinely free path still reserves exactly $0 (`chat` mode:"free" alone, `nvidia/*`, `phone/numbers/release`, GET `voice/call/{id}`) — important because `checkBudget` only short-circuits at exactly 0, so a $0.002 reserve on a free call would deny it on an exhausted budget. Every paid path still > $0. `search` returns a finite, positive reserve for all of `2.7 / 0.5 / 50.9 / 51 / 1e308 / Infinity / -Infinity / NaN / "10" / null / true / [] / {} / undefined`, and 50.9 still caps at 50. `modal` returns a finite reserve for every garbage body, and non-create paths stay $0.0030 regardless of what the body carries.
- **`modal` divergence on invalid input is harmless, confirmed live:** `gpu:"h100"` (lowercase), `gpu:"NOPE"`, `timeout:86401`, `timeout:"3600"` all return **HTTP 400 without charging**, so an estimate that diverges there costs nothing — the reserve is released in the `finally`. Every *valid* shape matches the header exactly.
- 165 tests, typecheck, build green.

## 0.31.4

Closes the last of the audit findings: every price an agent reads is now the price it is **charged**, verified against live `payment-required` headers.

- **`docs(surf)` — taught an endpoint that does not exist.** `chat/completions` (Surf-1.5) returns **404** on the gateway; the skill had a worked example, a catalog row, a trigger and pricing notes for it. All removed.
- **`docs(surf)` — Surf has no premium tier any more.** The skill billed `onchain/sql` at `$0.0200`. Upstream `SURF_TIER_1/2/3_PRICE` are now **all identical**, and `onchain/sql` quotes the same **$0.0095** as every other Surf read. The tier column is gone — one flat rate, SQL included.
- **`docs(gentech-blockrun)` — billed free calls.** `blockrun_price` crypto/FX/commodity quotes are **FREE**; the skill charged `$0.001` for them across four patterns and told agents to cache aggressively to save money that was never being spent. Also refreshed stale `defi` ($0.001 → **$0.0070**, prices/* → **$0.0030**) and `exa` ($0.01 → **$0.0120**) figures, and stopped quoting a flat rate for `blockrun_chat`, which is per-token.
- **`docs(crypto-data, search, phone)`** — repriced to the charge: `defi` **$0.0070** / prices/* **$0.0030**, `rpc` **$0.0040**, `surf` **$0.0095**, stocks **$0.0030**, `phone/lookup` **$0.0120**, `lookup/fraud` **$0.0520**, `numbers/list` **$0.0030**, `numbers/buy` **$5.002**. `search` understated every example — the default 10-source call settles **$0.2645**, not $0.25, and the skill now says it is priced per source and expensive by default.
- No code change; 165 tests, typecheck, build green.

## 0.31.3

- **`docs(modal)` — the tool and skill advertised `$0.01` for a call that can cost `$192`.** 0.31.2 fixed the *reserve* so the gate catches it; this fixes what we **tell the agent**, which is what walks it into the charge in the first place. Three separate lies, all live-verified:
  - **The price table said a flat `$0.01`.** `sandbox/create` is bimodal: `timeout ≤ 300s` is flat ($0.0120 CPU → $0.4020 H100); `timeout > 300s` bills **per-hour × the full requested lifetime, upfront, with no refund on early terminate** ($0.10/h CPU → $8.00/h H100). A 24h H100 sandbox is **$192.0020**.
  - **The skill's own worked example cost 67× its table.** `{ gpu: "A100", timeout: 600 }` quotes **$0.6687** live, not `$0.01`. Anyone copying the documented snippet was already on hourly billing and had no way to know.
  - **`timeout` was documented as "idle eviction".** It is the **billed lifetime** — you pay for the time you *ask for*, not the time you use. An agent told "idle eviction" would reasonably set a generous `86400` ceiling expecting to pay for what it consumes. That single misreading *is* the $192.
  - Also removed `A100-80GB` from the advertised GPU list — it does not exist; the gateway returns `HTTP 400 "Unsupported GPU type. Allowed: T4, L4, A10G, A100, H100"`.
- Every one of the 13 published prices was checked against the live `payment-required` header and matches exactly ($0.0120 / $0.0520 / $0.0820 / $0.1020 / $0.2020 / $0.4020 flat; $0.1020 / $1.5020 / $4.0020 / $8.0020 / $192.0020 / $0.6687 / $2.0020 hourly). Documents the flat→hourly cliff too: `timeout:300` is $0.0120 but `timeout:301` is $0.0104 — briefly cheaper on CPU, until ~432s.
- No code change to pricing logic; 165 tests, typecheck, build green.

## 0.31.2

Found by an adversarial multi-agent audit of everything shipped tonight. 0.31.1 fixed three tools by hand; that was treating symptoms. The gateway applies its flat $0.002 transaction fee in `buildPaymentRequirements` for **every** route, so **every** tool reserving the base was short. This fixes the class.

- **`fix(chat)` — CRITICAL: `mode:"free"` plus an explicit PAID model reserved $0, a total budget-gate bypass.** `estimateChatCost` returned `0` on `mode === "free"` unconditionally, but an explicit `model` **wins over `mode`** at call time (`targetModel = model || MODEL_TIERS[mode ?? "balanced"][0]`). So `{ mode:"free", model:"openai/gpt-5.5" }` ran a frontier model against a **$0 reserve** — any agent, including one already at its cap, got unmetered frontier calls by tacking on `mode:"free"`. Worst case measured: `mode:"free"` + `claude-opus-4.8` + a 100k thinking budget reserved **$0** on a call that settles over **$2**. Now an explicit model is priced on its own merits and `mode:"free"` only grants free when no model overrides it; genuinely free paths (`mode:"free"` alone, `nvidia/*`) still reserve $0.
- **`fix(phone)` — CRITICAL: unlisted paid routes reserved AND recorded $0.** The catch-all returned `hasBody ? 0.001 : 0`, so any paid GET missing from the table was invisible to both the gate and the ledger. **`/v1/phone/numbers/search` is live and charges $0.0120** — and appears in neither this table nor the gateway's own `PHONE_PRICES`, so the table cannot be trusted to stay complete. Unknown routes now **fail closed** at $0.0120; explicitly-free reads stay $0.
- **`fix(budget)` — the $0.002 tx fee was missing from six more estimators.** New shared `src/utils/tx-fee.ts` (`withTxFee`) mirrors the gateway's `addTransactionFee`, including its `$0` no-op so free tiers stay free. Verified against live `payment-required` headers: `defillama/protocols` $0.005→**$0.0070**, `prices/*` $0.001→**$0.0030** (3x short), `exa/search` $0.010→**$0.0120**, `rpc` $0.002→**$0.0040** (2x short), `phone/lookup` $0.010→**$0.0120**, `phone/numbers/list` $0.001→**$0.0030** (3x short), plus `modal`. `rpc` batches take the fee **once per request, not per element**.
- **`fix(chat)` — float drift in the reserve.** `(1024/1e6)*20` is `0.020479999999999998`, which surfaced verbatim in budget messages. Rounded to micro-dollars.
- **`fix(modal)` — CRITICAL: `sandbox/create` is priced off the BODY, and the estimator read the path — 16,000x short.** The gateway's pricing is bimodal (`getModalCreatePricing`): `timeout <= 300s` is a flat rate (CPU $0.01, GPU per tier), `timeout > 300s` bills **hourly x the full requested lifetime, upfront, with no refund on early terminate**. Estimating on the path reserved a flat $0.01 for every create — so `{ timeout: 86400, gpu: "H100" }` reserved **$0.012** against a live-verified charge of **$192.0020**. A $1 agent cap could settle $192 of non-refundable spend. The estimator now mirrors the gateway's tables (T4/L4/A10G/A100/H100, flat + hourly), takes the body, and falls back to the CPU rate on an unknown gpu exactly as the gateway does. Verified against live headers: `$192.0020`, `$4.0020`, `$0.4020`, `$0.1020`, `$0.0120` — all exact.
- **`fix(security)` — CRITICAL: `hasPathTraversal` was bypassable with an embedded tab/newline.** The URL spec has the parser **delete** every ASCII tab (U+0009), LF (U+000A) and CR (U+000D) before parsing, so `..<TAB>` is not a `..` segment to an equality check but IS one by the time `fetch()` resolves it. `blockrun_surf({ path: "..\t/phone/numbers/buy" })` reserved **$0.0095** and reached the **$5.00** endpoint — a 526x under-reserve that also escaped `--profile` tool scoping. All seven path tools were affected. The guard now strips those characters before splitting, and the new test asserts each payload **actually escapes the namespace against the real parser** before asserting the guard blocks it.
- **`fix(price)`** — paid stock calls reserved $0.001 against a **$0.0030** charge (3x short).
- **`fix(search)`** — the reserve floored `max_results`; the gateway prices the **raw** value (`2.7` quotes a $0.0709 base vs `2` at $0.0525). Flooring under-reserved on any fractional input.
- **Not changed, deliberately:** the audit recommended dropping `checkBudget`'s `cost > 0` guard so a $0 reserve can still be denied. Rejected — this server has genuinely free paths (`blockrun_price` crypto/fx/commodity, `blockrun_dex`, `mode:"free"`, `nvidia/*`, free phone reads) and denying them on an exhausted budget would be a regression, since a free call spends nothing. The real defect was **paid** calls estimated at $0, fixed above at the source. Verified on an exhausted budget: free calls pass, the $192 modal call is denied.
- **`fix(image)` — the reserve, the Cost footer and the ledger all understated real spend.** `estimateCost` returned the raw catalog figure while the gateway settles `catalog x 1.05 + $0.002` — `zai/cogview-4` reserved $0.0150 against a live-verified **$0.017751** (15.5% short); `google/nano-banana-pro` $0.10 vs **$0.107001**. The estimate now mirrors the server's arithmetic **including its float drift**, which is load-bearing: `0.015 * 1.05` is `0.015750000000000002`, so `ceil((base*1.05 + 0.002) * 1e6)` yields `17751` where any pre-rounded version yields `17750` and lands a micro short. Reserve, footer and ledger now all report the charged price.
- **`fix(speech)`** — `MIN_PAYMENT_USD` mirrored the server's **base** floor. The gateway's own route says *"Price = (characters / 1000) x model rate, minimum $0.003/request"* — that $0.003 is $0.001 + the $0.002 fee, so a short render reserved 3x short.
- 165 tests, typecheck, build, stdio smoke green; every fixed reserve checked against the live gateway.

## 0.31.1

- **`fix(budget)` — every paid tool reserved the BASE price, not the price. The 402's JSON `price` field is not what x402 charges.** A 402 body reports `price: {amount: "0.0075"}` — that is the base. What actually gets charged is `maxAmountRequired` inside the base64 **`payment-required` header**, and it is base **+ a $0.002 flat transaction fee**. The gateway states the split itself in `src/app/api/v1/pm/[...path]/route.ts`: *"Tier 1 (GET) = $0.0095/call ($0.0075 base + $0.002 tx fee)"*. Decoded live: every `/v1/surf/*` and `/v1/pm/*` route returns `maxAmountRequired=9500` → **$0.0095**.
- **`blockrun_markets` was ~9.5x short.** `estimateMarketCost` still returned the pre-flat tiers (`$0.001` / `$0.005`) — 0.31.0 updated the tool *description* to flat but not the estimator. So the gate reserved `$0.001` against a `$0.0095` charge, and `recordSpending()` booked `$0.001` of a `$0.0095` spend: the budget **ledger** under-counted too, not just the reserve. Now flat `$0.0095`.
- **`blockrun_surf` was $0.002 short.** Its own comment already said *"the gateway adds a $0.002 transaction fee on top → $0.0095 customer-facing"* and *"this estimator feeds the BUDGET GATE, so it must never under-quote"* — and then set the constant to the base. Now `$0.0095`.
- **`blockrun_search` was $0.002 short** — 0.30.10 fixed the 5% buffer but pinned the body's `price` field, so it stayed under by the flat fee at every size. Reserves now match the header exactly: `max_results` 1/5/10/20/50 → `$0.0283/$0.1333/$0.2645/$0.5270/$1.3145`. Tests repinned to the **charged** column; `test/surf.test.ts` likewise.
- **Skills corrected**: `prediction-markets`, `crypto-data`, `surf` and `gentech-blockrun` advertised `$0.0075`. Users pay **$0.0095**. An agent budgeting off those numbers under-reserves on every call.
- **The lesson, now written into the code**: the base is not the price. Read `maxAmountRequired` from the `payment-required` header. This has been wrong twice in the same direction — first stale tiers after the gateway went flat, then the base mistaken for the price — both times by trusting a number that looked authoritative. The public pricing pages (`/services/surf` $0.0095, `/services/predexon` GET $0.003 / POST $0.007 for the then-current base) were **right all along**.

## 0.31.0

- **`fix(surf,markets)` — Surf and Predexon are now one flat $0.0075/call, and the budget gate was under-reserving.** The gateway collapsed every prediction-market / crypto-data tier to a single network-uniform price (2026-07-15). `estimateSurfCost()` still priced from tier tables ($0.001 / $0.005 / $0.02) — and it had *already* drifted before this change, since the gateway moved Surf T1/T2 to $0.0075 while the estimator kept quoting $0.001. It feeds the spend cap, so every cheap-looking call reserved less than it cost. It now returns the flat rate, which deletes the drift at the root rather than re-syncing a table that will drift again.
- **The tier tables are gone, not just unused.** `SURF_T2_PATHS` / `SURF_T3_PATHS` / `SURF_T2_PREFIXES` classified paths only to price them; with a flat rate nothing reads them, and leaving them would make dead code look load-bearing. The old "a query string downgrades the tier and under-records spend up to 20×" bug is now unrepresentable — there is no tier left to misclassify. The regression test is kept, asserting no path perturbation can change the quote.
- **`fix(skills)` — the routing advice was arguing from a price gap that no longer exists.** `crypto-data` and `surf` skills told agents "Predexon serves the same Polymarket/Kalshi data at $0.0010 vs $0.0075 — 7.5× cheaper". Both now bill the same. The conclusion is unchanged — still route prediction markets to `blockrun_markets` — but for **coverage**, which is the real reason: wallet clustering, smart money, sports, UMA, and five venues Surf does not carry at all. An agent routing on a stale price is making the right call for a wrong, checkable reason.
- Prices synced across `blockrun_surf` / `blockrun_markets` tool descriptions, `prediction-markets` / `crypto-data` / `surf` / `gentech-blockrun` skills, the polymarket positions fallback hint, and the README. Untouched: `$0.001` that belongs to other products (stocks quotes, DefiLlama prices, Modal) — several sit on adjacent rows of the same tables.

## 0.30.10

- **`fix(search)` — the budget gate reserved less than a search actually costs.** `blockrun_search` is the most expensive tool here (priced per *source*: a default call settles ~$0.26 while most tools cost $0.001), and its reserve mirrored `$0.025 x max_results` — but the gateway settles **5% above that, rounded up to 4dp**. So every search reserved short, and the gate exists precisely to stop an agent overshooting its cap. Verified against the gateway's own 402 quotes, which are free to request (send any call with no payment header and it replies with the exact price): `max_results` 1/5/10/20/50 quote $0.0263/$0.1313/$0.2625/$0.5250/$1.3125 — the reserve now matches each exactly.
- Computed in **integer micro-dollars**, because the float form is not exact: `0.025 * 1.05` is `0.026250000000000002`, which rounds to `$0.026251` — still under the gateway's `$0.0263`, i.e. still short. A reserve must never be short. New `test/search-cost.test.ts` pins the five live quotes, the bare-`{query}` default, the 50-source ceiling, and that garbage `max_results` (`0`, `-5`, `"10"`, `null`, `NaN`, `{}`) falls back to the default reserve rather than $0 — a $0 reserve is a gate bypass.
- The tool description was understating it too (`default max_results=10 → $0.25`); it now leads with the fact that search is priced per source and expensive by default (~$0.26 at the default, ~$1.31 at 50), and suggests capping `max_results`.
- **`fix(build)` — tests were never typechecked.** `tsconfig.json` had `include: ["src/**/*"]`, so `npm run typecheck` passed while `test/` contained genuine type errors — which is exactly how 0.30.6's broken `estimateChatCost` call signatures reached a commit. Proven before fixing: a planted `const _bad: number = "definitely not a number"` in `test/chat.test.ts` typechecked clean. Now `include: ["src/**/*", "test/**/*"]` and the same planted error fails with `TS2322`. `dist/` is unaffected (tsup builds from `entry`, not `include`) — no test artifacts ship.

## 0.30.9

- **`docs(skills)` — new `crypto-data` skill: three crypto tools had no skill, and agents were paying for data two of them give away free.** `blockrun_defi` (DefiLlama TVL/yields), `blockrun_price` (Pyth quotes + OHLC for crypto/FX/commodities/12 stock markets), and `blockrun_dex` (DexScreener pairs/liquidity) were mentioned only in passing by the general `gentech-blockrun` catalog — no triggers, no paths, no examples. They were effectively undiscoverable.
- **Routes by cost, because five tools overlap and two are free.** An agent asked *"what's BTC worth?"* can plausibly reach for `blockrun_price`, `blockrun_surf`, `blockrun_dex`, `blockrun_defi`, or `blockrun_rpc`, and nothing told it which. **`blockrun_price` is free for crypto/FX/commodities and `blockrun_dex` is free outright** — while the same BTC quote through `blockrun_surf` (`market/price`) costs **$0.0095**. The skill leads with a cost-ordered routing table and states the rule plainly: a plain crypto price or DEX pair is free; only reach for `blockrun_surf` when you need what the free tools genuinely lack (on-chain SQL, 100M+ wallet labels, social, news, unlocks, liquidations, ETF flows).
- Documents every `blockrun_defi` path with prices, every `blockrun_price` action/category/market, and `blockrun_dex`'s params; cross-links `skills/surf/SKILL.md` (83 endpoints) and `skills/rpc/SKILL.md` rather than duplicating them. Worked examples are compound and free-first — e.g. *"is this token legit?"* starts with free `blockrun_dex` liquidity and only pays for holders/unlocks once the free signal justifies it.
- **Verified live, not asserted:** every tool, path, action and category checked against the running server; the FREE claims confirmed end-to-end — `blockrun_price` crypto returned a real BTC quote and `blockrun_dex` real PEPE liquidity with the wallet balance **unchanged to the micro-dollar** (64.946044 → 64.946044).
- **`fix(skills)` — Surf's own skill had the wrong prices, and pointed agents at the expensive vendor.** It advertised three tiers ($0.001 / $0.005 / $0.020). The gateway's real price is **flat $0.0075** for all 80 standard endpoints, $0.0200 premium. Confirmed by asking the gateway itself — an unpaid request returns a 402 quoting the exact price, and costs nothing: `market/price`, `wallet/labels/batch`, `social/mindshare`, `news/feed`, `exchange/klines` and `search/web` all quote $0.0075. (The public service pages are wrong too: **/services/surf** says $0.0095/$0.022, and **/services/predexon**'s header says GET $0.003/POST $0.007 while its own table correctly says $0.001/$0.005.)
- **Predexon and Surf overlap on prediction markets, and Surf is the wrong answer every time.** Surf carries 17 `prediction-market/*` endpoints and its description advertises "prediction-market positions", so an agent asking for Polymarket odds could legitimately land there — and pay **$0.0075 against Predexon's $0.0010 for identical data, 7.5x**. Predexon also has wallet clustering, smart money, leaderboards, sports, UMA and five more venues that Surf lacks entirely; Surf owns on-chain SQL, 100M+ wallet labels, 16 CEXs, social, news and unlocks that Predexon lacks entirely. Both skills now state the split explicitly and link each other, so the one place you can lose money routes correctly.
- No code change; `dist/` is byte-identical to 0.30.8.

## 0.30.8

- **`docs(skills)` — the prediction-markets skill never mentioned the tool it ships with, so agents could not reach Predexon at all.** `skills/prediction-markets/SKILL.md` referenced `blockrun_markets` **zero** times across 263 lines while teaching `client.pm(...)` — the Python SDK — 37 times. An agent in Claude Code following it would try to `import blockrun_llm` and write Python instead of calling the tool sitting right in front of it. Rewritten against the live registry on the pattern `skills/surf/SKILL.md` already proved: MCP invocation first (`blockrun_markets({ path, params, body })`), Python demoted to a "for non-MCP use" footnote.
- **It also taught three paths that do not exist.** `polymarket/search`, `polymarket/query`, and `kalshi/query` are absent from the live Predexon registry (the real path is `markets/search`), so an agent that got past the Python problem would have 404'd anyway. Removed.
- **The endpoints worth paying for were invisible.** `triggers:` had no entry for smart money, whales, leaderboards, P&L, price history, candles, orderbooks, or open interest — so the skill never fired for those intents and 42 of 58 endpoints were undiscoverable. Triggers 16 → 42; decision table 16 rows → **all 58 endpoints**; description now leads with what a public API cannot give you (history that cannot be backfilled, wallet clustering, smart-money positioning, cross-venue canonical IDs — no account, no API key) rather than "Predexon v2, $0.001/call".
- **Added worked examples phrased as user questions**, including compound recipes that show why the data is worth paying for: *"who's smart money betting on in this market?"* (`market/{id}/smart-money` → `wallet/{addr}` → `wallet/positions/{addr}`), *"this whale is up 400% — who are they really?"* (`identity` → `cluster` → `pnl` → `similar`), *"find me something to copy-trade"*, and *"is the same bet cheaper on another venue?"*.
- No code change; `dist/` is byte-identical to 0.30.7.

## 0.30.7

- **`docs` — the README documented a feature 0.30.6 deleted.** `routing:"smart"` was removed from `blockrun_chat` along with the ClawRouter dependency, but three README claims survived the release and shipped inside the package (`files` includes `README.md`, so it is also what npmjs.com renders): the Base-only fallback list, a **CRITICAL** note telling agents smart routing is Base-only, and a troubleshooting entry for a `Smart routing (ClawRouter) not available on Solana` error that can no longer occur. Anyone following them would pass `routing:"smart"`, get nothing back, and reasonably conclude the server was broken — the exact failure mode 0.30.6 set out to end. Removed all three. The ClawRouter links under Related Projects stay: it is still a real product, just no longer anything this server depends on.
- No code change; `dist/` is byte-identical to 0.30.6.

## 0.30.6

- **`fix(deps)` — decouple from ClawRouter, and bust the npx caches poisoned by its outage.** From 2026-07-11 to 07-14, `npx -y @blockrun/mcp@latest` could not start at all: `SyntaxError: Identifier '__cjs_createRequire' has already been declared`. Nothing was wrong with this package. `@blockrun/clawrouter@0.12.220` published a bundle that had inlined a stale copy of *itself* (it and `@blockrun/llm` depend on each other, so its own `noExternal` build resolved the back-import to the last published dist in `node_modules`), and the duplicated banner made every entrypoint a load-time `SyntaxError`. Fixed upstream in `@blockrun/clawrouter@0.12.222`.
- **Why it reached us at all:** we pinned `@blockrun/llm: ^2.11.0`, which caps on the 2.x line — where the router is a hard dependency, statically imported at `dist/index.js:29`. So every MCP start-up eagerly loaded ClawRouter's entire bundle to serve tools that never route. Now on `@blockrun/llm: ^3.6.1`, where it is an **optional peer dependency npm does not install at all**. ClawRouter is gone from the tree: `removed 54 packages`, ~50MB, about **15% of a 328MB install**.
- **`fix(chat)!` — `routing:"smart"` is removed** (BREAKING: `blockrun_chat` no longer accepts `routing` / `routing_profile`). It auto-picked the cheapest capable model, which serves an agent that has no model of its own. But every caller here is *already running inside a frontier model* and reaches for this tool to get what that model **lacks**: a specific model, an image, live X data. Nobody in Claude Code needs us to pick a cheap model for them. It was the only caller of `llm.smartChat()` — hence the only reason the router was ever in our dependency tree, and the only reason a broken ClawRouter bundle could take this server down. Want a cheap model? `mode:"cheap"` / `mode:"glm"` or an explicit `model:` — both resolve here, with no router.
- **Why this needs a version bump rather than just the upstream fix:** npx keys its cache on the *spec*, not the resolved tree. With `@blockrun/mcp` still at 0.30.5, `npx -y @blockrun/mcp@latest` considers `~/.npm/_npx/68ab1540555296f1` already satisfied and reuses the poisoned ClawRouter forever. Measured: a cache holding 0.30.5 stays broken on retry; one holding 0.30.4 rebuilds and heals. Publishing 0.30.6 makes `latest` outrank every cached copy, so affected installs self-heal on next run with no manual cache clearing.
- **Why local dev never caught it:** our lockfile pins `@blockrun/clawrouter@0.12.214`, so no developer machine was ever exposed. Published packages don't ship lockfiles, so users resolved `^0.12.190` fresh and got `0.12.220`. Reproducing installs the way a user gets them — not the way the repo builds — is now the standard for this class of bug.
- 151 tests, typecheck, build, stdio smoke green. Verified end-to-end against the published registry, including a **live x402 payment settled on Base with the router absent** (`-0.010160 USDC`, `zai/glm-5`) — the payment path survives the `@blockrun/llm` 2.x→3.x major bump.

## 0.30.5

- **`fix(polymarket)` — `redeem` actually pays out now: route redemption through Polymarket's pUSD collateral adapters.** A user reported three redeems that returned success + a tx hash while Polymarket's data-api logged each as `REDEEM size=0`. Root cause (verified on-chain with live markets): V2-era CLOB token_ids are still keyed to **USDC.e** (standard markets) or the legacy NegRiskAdapter's wrapped collateral (neg-risk) — **not pUSD**. Redeeming via `CTF.redeemPositions` with pUSD collateral recomputes a positionId nobody holds, and the CTF does **not** revert on a zero balance: it burns nothing, pays nothing, and the transaction *succeeds*. The fix targets the canonical pUSD collateral adapters from [docs.polymarket.com/resources/contracts](https://docs.polymarket.com/resources/contracts) (Sourcify `exact_match`; identity constants — CTF, pUSD, USDC.e, legacy adapter, wrapped collateral — verified on-chain before wiring): `CtfCollateralAdapter` `0xAdA100…FcE1f` (standard) and `NegRiskCtfCollateralAdapter` `0xadA200…eAab` (neg-risk). They pull the caller's outcome tokens, redeem through the right underlying path, wrap the USDC.e payout into pUSD, and return **pUSD** to the deposit wallet. Setup's approval batch adds the two adapter operator approvals (they pull via `safeBatchTransferFrom`); **existing wallets self-heal — run `action:"setup" confirm:true` once before your next redeem.** Hardened after an adversarial multi-agent audit of the fix: the success message now reports the actual **payout delta** (a $0 payout while winning tokens were held returns a loud ⚠️ instead of a ✅), the EOA path checks `receipt.status` (a mined-but-reverted tx no longer prints ✅), the EOA approvals loop gets the same check, and the relayer-batch failure text now matches the missing-approval hint. New `test/polymarket-redeem.test.ts` pins the literal adapter addresses + calldata shape. 153 tests, typecheck, build, stdio smoke green.

## 0.30.4

- **`fix(polymarket)` — retire the last stale manual-relayer-creds guidance and align every runtime/doc surface with actual behavior.** A two-round multi-agent audit of the `polymarket-trading` skill against the implementation (69 claims verified, every finding adversarially re-checked) surfaced 24 stale or contradictory statements left behind by the builder-key bootstrap (0.30.0) and Finland-egress (0.30.3) transitions; all fixed:
  - **Tool description** no longer demands `POLYMARKET_RELAYER_API_KEY/_SECRET/_PASSPHRASE` (credentials have been auto-bootstrapped from the wallet key since 0.30.0) and now states the Finland-egress geoblock default instead of the pre-0.30.3 "US/UK/EU are close-only" wording.
  - **Dead manual-creds code deleted** (-77 lines): `relayerCredsMissing()`/`relayerCredsMissingMessage()` (hard-coded `false`/`""`), the unreachable `setup` branch that told users to fund "while you get relayer creds", `deriveDepositWalletNoCreds()`, and the never-called `RelayerCreds`/`getRelayerCreds` env config.
  - **Proxy ≠ egress, consistently.** The 403 error, `setup`'s region line, the SKILL, README, and setup guide all said (or implied) `POLYMARKET_CLOB_PROXY` / `HTTPS_PROXY` re-route the egress. They don't — a proxy only changes how the current CLOB host is reached; Polymarket still sees the Finland relay's IP unless `POLYMARKET_CLOB_HOST` is also repointed. Every surface now leads with the host repoint and states the proxy caveat.
  - **EOA mode (`POLYMARKET_SIG_TYPE=0`) honestly framed.** The skill claimed it is "read-only for orders" while simultaneously recommending it for the issue-#65 error; the code prints an unconditional "Ready to trade". All surfaces now agree: a diagnostic fallback — the CLOB may reject plain-EOA makers on order placement.
  - **Signer-key custody claims qualified.** `~/.blockrun/.session` is the *default* signer source; a `BLOCKRUN_WALLET_KEY` env var or an existing agent `wallet.json` takes precedence (per `@blockrun/llm` key resolution) — so the backup notes (skill, README, setup guide, `setup` output, `blockrun_wallet` output) now say to back up the key behind the signer address `setup` prints, wherever it lives, instead of hard-coding one path that may not hold the controlling key. README's env table gains the missing `BLOCKRUN_WALLET_KEY` row.
  - Skill step-0 note inverted for the Finland default (geoblocked users set **nothing**; `POLYMARKET_CLOB_HOST` is for opting out), and the fund-before-deploy error no longer says deploy "needs relayer creds". 150 tests (maker-rejection assertion updated), typecheck, build, stdio smoke (19 tools) green.

## 0.30.3

- **`fix(polymarket)` — default the CLOB geoblock egress to Finland (`europe-north1`), retiring the Tokyo relay.** Order placement routes through a hosted egress in a permitted region; the default now points at BlockRun's **Finland** relay instead of Tokyo. Per Polymarket's own geographic policy, Finland is **fully unrestricted** (frontend *and* API), whereas Japan is "close-only on the frontend" — a gray zone at risk of tightening. Verified from the new egress: `GET /clob/version` → `{"version":2}`, `POST /clob/order` → **401 (permitted, not 403)**, geoblock → `{"blocked":false,"country":"FI"}`. Deploy recipe moved to [`deploy/finland-egress/`](deploy/finland-egress). Override with `POLYMARKET_CLOB_HOST` as before (go direct with `https://clob.polymarket.com`, or run your own egress). No API/behavior change beyond the default host.
- **`docs`** — Tokyo → Finland across the README, the setup guide, and the `polymarket-trading` skill; corrected the region note (US/UK + specific countries are close-only; Ireland/Finland/Japan-API are open).

## 0.30.2

- **`fix(polymarket)` — grant the missing `pUSD → NegRisk Adapter` approval so neg-risk ("winner"/multi-outcome) markets can actually be traded.** `setup`'s approval batch granted pUSD (ERC-20) spend to only the two exchanges, while giving the NegRisk Adapter a CTF *operator* (ERC-1155) approval but **not** the pUSD one — an asymmetry that let `setup` report ✅ ready yet neg-risk buys fail: the CLOB accepts the order, then settlement through the adapter reverts. The pUSD spender set now matches Polymarket's own canonical `approveTokensForTrading` (both exchanges, the **NegRisk Adapter**, and the Conditional Tokens contract). Since `readApprovals` reads on-chain every run, existing deposit wallets self-correct — re-run `action:"setup" confirm:true` once to sign the newly-required approval. Root-caused from a real user's funded-but-failing bet on a World Cup winner market (deposit wallet fully funded + exchange-approved on-chain; the field diagnosis of an "approval never landed / gasless relayer" bug was a flaky-public-RPC artifact — `polygon-rpc.com` returns `401 tenant disabled` that reads as allowance 0).
- **`fix(polymarket)` — buy/sell now self-heal a stale CLOB balance cache instead of failing a funded wallet.** The CLOB keeps a server-side balance/allowance cache; `setup`'s warm-up refresh was best-effort and **silently swallowed** (`.catch(() => undefined)`), so a failed warm-up left `setup` printing "ready" while the exchange still saw balance 0 → `not enough balance/allowance` on a fully-funded vault. On that rejection the order path now refreshes the cache (`updateBalanceAllowance` — COLLATERAL for buys, the outcome token for sells) and retries the submit **once** (mirrors the existing #65 creds-retry); `setup` surfaces a warm-up failure as a note rather than hiding it. New test `test/polymarket-balance-retry.test.ts` (stateful fake CLOB: stale-cache reject → refresh → retry succeeds; and a persistent rejection retries exactly once then maps the error). 152 tests, typecheck, build green.
- **`docs(polymarket)` — document the full canonical approval set and neg-risk troubleshooting** across the README, `docs/polymarket-trading-setup.md`, and the `polymarket-trading` skill (the four pUSD spenders, why the NegRisk Adapter grant matters, and "re-run `setup confirm:true` after upgrading to grant a newly-required approval").

## 0.30.1

- **`fix(polymarket)` — make `setup` resilient to transient Polygon RPC failures.** The five approvals reads (pUSD `allowance` ×2, CTF `isApprovedForAll` ×3) and the pUSD `balanceOf` read went straight through viem's `fallback` transport — which rotates RPCs on a *transport-level* error but does **not** retry a decode error from a flaky public RPC that returns a bad/stale 200 body, so a single hiccup on any read erred the **entire** `setup` (observed ~1-in-3 on a cold first run). Adds a read-level retry (4 attempts, backoff — re-running the read gives the fallback a fresh transport) around those reads, and hardens the transports (`retryCount` on each `http` and on the `fallback`). Verified 10/10 back-to-back setups green. Surfaced by an end-to-end test of the *published* package over the MCP stdio protocol (tools registered in the trading profile; setup / positions / orders / dry-run buy / dry-run fund / empty-vault withdraw all correct). No behavior change on the happy path.

## 0.30.0

- **`feat(polymarket)` — zero-config trading, gasless x402 funding, and the corrected POLY_1271 auth. First *published* release of `blockrun_polymarket`.** Supersedes the never-published 0.29.0 (its publish was blocked by a red test until this cut) and makes the full lifecycle work out of the box — verified end-to-end with real money on the live CLOB: fund → deploy → buy → sell → withdraw, from a US machine, zero configuration. Changes since 0.29.0:
  - **Corrected clob-client-v2 [#65](https://github.com/Polymarket/clob-client-v2/issues/65) fix.** 0.29.0 bound CLOB creds to the deposit wallet via an ERC-7739-wrapped L1 ClobAuth (the fix the issue *proposed*) — which the CLOB rejects with *"Invalid L1 Request headers"*. The working path, matching Polymarket's reference Rust client (`rs-clob-client-v2`): L1/L2 auth is the **owner EOA's** plain signature (the API key binds to the EOA), while POLY_1271 orders carry signer/maker = deposit wallet and are validated on-chain by the vault's ERC-1271 `isValidSignature`. `getClobClient()` derives EOA creds and hands the real EOA signer + the deposit wallet as `funderAddress`. Verified: a real $1 order matched.
  - **No manual credentials.** The MCP bootstraps its own Builder API key from the user's wallet via the CLOB `createBuilderApiKey()` (L2-authed) for the gasless relayer's HMAC auth — no Polymarket account, no "get a relayer key from the website" step. Cached 0600 at `~/.blockrun/.polymarket-builder-creds`.
  - **Gasless x402 funding (`action:"fund"`).** One call moves Base USDC into the vault as pUSD: signs an EIP-3009 authorization, the BlockRun gateway charges $0.01 and settles the deposit **straight to the Polymarket bridge** (non-custodial — the USDC never touches BlockRun; CDP sponsors the Base gas); the bridge unwraps to pUSD in the vault. $2 minimum; the credit is async, so it reports SUBMITTED with the pUSD credit PENDING rather than "funded" (#226).
  - **`action:"withdraw"` — cash out pUSD → native USDC on Base**, delivered to the agent wallet (the same key that pays x402 fees). Verified: $3.01 landed on Base in ~30s.
  - **Zero-config geoblock bypass.** `POLYMARKET_CLOB_HOST` now defaults to BlockRun's hosted Tokyo egress, so order placement works from geoblocked regions (US/UK/EU) out of the box — verified: a US machine reports `Region: order placement permitted (egress JP)` with no config. Fully overridable (go direct with `https://clob.polymarket.com`, or run your own via `deploy/tokyo-egress`). The relay only forwards to Polymarket; every order is still signed locally. (Operational note: this makes the relay production-critical for order placement.)
  - Underscore-auth-header survival bridge (proxies/Cloud Run strip `POLY_*` headers — sends hyphenated copies too); 1rpc-first Polygon RPC order (polygon-rpc.com was lagging). User guide rewritten (`docs/polymarket-trading-setup.md`) and the `polymarket-trading` skill now teaches the agent the zero-setup flow (fund via x402 → buy → sell → redeem → withdraw). 148 tests, typecheck, build green.

## 0.29.0

- **`feat(polymarket)` — new `blockrun_polymarket` tool: real trading on Polymarket (CLOB V2, Polygon).** Actions: `setup` (gasless deposit-wallet provisioning via Polymarket's relayer: CREATE2 derive → deploy → confirm-gated approval batch → L2 creds → CLOB balance-cache refresh), `buy`/`sell` (limit GTC/GTD + market FOK/FAK, tick-rounded, min-size-checked), `orders`, `cancel`, `positions` (free Data-API), `redeem` (gasless via relayer; NegRisk adapter aware). Non-custodial: every order/approval/redeem is EIP-712-signed locally by the existing `~/.blockrun/.session` key (one identity pays x402 on Base AND bets on Polygon); the relayer/CLOB only ever receive signed, tamper-evident payloads. Safety is server-side and deliberately separate from the x402 budget ledger (different asset, different wallet): `confirm:true` hard-required to sign anything (dry-run preview otherwise), `POLYMARKET_MAX_BET_USD` per-order cap (default $25), optional `POLYMARKET_MAX_SESSION_USD`, secrets never printed (creds/state at `~/.blockrun/.polymarket*`, 0600). Ships a workaround for the open clob-client-v2 [issue #65](https://github.com/Polymarket/clob-client-v2/issues/65) (L1 auth not ERC-7739-wrapped for POLY_1271, so API keys bind to the EOA and every deposit-wallet order 400s): `l1-auth-1271.ts` derives creds bound to the deposit wallet with the same TypedDataSign envelope the SDK uses for orders, plus an address-reporting signer shim so L2 headers carry the funder — pinned by a golden-vector test and an independent viem signature-recovery test; auto-recovery re-derives creds once on the mismatch fingerprint. `POLYMARKET_SIG_TYPE=0` gives a plain-EOA fallback. Geoblock-aware: runtime region check in setup and on 403s (US/UK/EU are close-only), `POLYMARKET_CLOB_PROXY`/`HTTPS_PROXY` egress passthrough — the proxy covers CLOB order traffic AND the relayer's own (separate-axios) deploy/approve/redeem calls, so a US-egress demo routes every geoblockable Polymarket request through one permitted egress. Deps: `@polymarket/clob-client-v2@1.0.8` (exact-pinned — the patch mirrors its signing internals), `@polymarket/builder-relayer-client`, `@polymarket/builder-signing-sdk@0.0.8` (pinned for dedupe), `axios`, `https-proxy-agent`. Registered in the `full` + `trading` profiles (19 tools). Hardened after a 4-dimension adversarial multi-agent review (money-safety / crypto / correctness / integration): conservative side-aware tick rounding (a limit BUY floors so a signed price never beats the user's limit, and a sub-tick buy is rejected rather than silently lifted); atomic reserve-then-commit session accounting (rolls back on a failed submit, closing a TOCTOU overshoot under concurrent orders); `success:true` + informational `errorMsg` (CLOB "delayed") treated as placed, not thrown — preventing duplicate submits; market SELL with no book bid rejected instead of $0-notional bypassing the caps; money caps fail CLOSED on `0`/garbage with a stderr warning; deposit-wallet state keyed to the signer so a rotated key never points funding at an unrecoverable vault; `POLYMARKET_BOUNDED_APPROVALS` honored in EOA mode and in the "already-approved?" check; `assertContractConfig()` runs before any approval signature; tightened creds-mismatch classifier (no false-positive on a "401" inside a token id); credential-derivation errors never echo response bodies; positions paginated. 132 tests green (10 new suites incl. confirm-gating, cap/tick/min-size enforcement, reserve-rollback, delayed-status, and an L1-auth golden vector + independent signature-recovery check); typecheck + build green.

## 0.28.0

- **`fix(wallet)` — top-up now mints a real Coinbase Onramp link instead of the dead `buy.blockrun.ai`.** 0.27.0 opened a static `https://buy.blockrun.ai`, which doesn't resolve (NXDOMAIN) — the browser opened to a "can't reach this site" page. Replaced with the real funding path: `blockrun_wallet action:"deposit"` (and the paid tools' out-of-funds branches) now call the gateway's free `POST /v1/onramp/token` with an x402 wallet signature ($0 — the signature only proves wallet ownership, nothing settles) to mint a **one-time `https://pay.coinbase.com/...` session URL**, then open that. The user buys USDC with a card and it settles directly into their own self-custody Base wallet — the MCP equivalent of Franklin's in-panel "Buy USDC with card", without a local dashboard server. Base-only (Coinbase can't onramp SPL USDC); on Solana `launchTopUp` returns address/QR guidance. Verified end-to-end against the live gateway with a fresh empty wallet: `deposit` and an out-of-funds `blockrun_image` each minted a distinct working `pay.coinbase.com` link. No media-tool `description`/schema changes (the link appears only in a runtime error), so the MCP prompt length is unchanged.

## 0.27.0

- **`feat(wallet)` — out-of-funds now auto-opens the BlockRun top-up page.** Adds `blockrun_wallet action:"deposit"`, which launches `https://buy.blockrun.ai` in the user's default browser (best-effort via a new `openUrl` helper) and returns the link plus the active-chain address as a fallback for headless/permission-restricted environments. The paid media tools (`blockrun_image`, `blockrun_video`, `blockrun_music`, `blockrun_speech`, `blockrun_realface`) now auto-open the same top-up page in their out-of-funds failure branch and print the link in the error, so a user whose wallet ran dry is taken straight to funding instead of a dead-end error. Server-side only: no tool `description`/schema changes on the media tools (the link text appears solely in a runtime error), so the MCP prompt length is unchanged. No token minting, no x402, no local panel server — just the hosted funding portal (the MCP equivalent of Franklin's in-panel top-up). Adds a handler test with `open` mocked (no browser launches).

## 0.26.0

- **`feat(media)` — every media tool now reports the USDC cost in its result.** `blockrun_image`, `blockrun_video`, and `blockrun_music` returned the URL/model but no price, so on a bare MCP (without the plugin's `announce-cost` skill) the user never saw what a generation charged — the cost was booked to the budget ledger but never surfaced. Each now appends a `Cost: $X.XXXX` line and a `cost_usd` field to `structuredContent`, matching `blockrun_speech` / `blockrun_realface` which already did this. Video and music report the **real 402-settled amount** (both are token-priced upstream, so 1080p/4K clips and long tracks can exceed the per-unit estimate); image uses the catalog estimate on Base and the 402 amount on Solana — each falls back to the estimate only if the quote doesn't parse. No new spend path and no behavior change to what is charged — the figure shown is the same amount already recorded to the budget. Adds handler-level tests for the image/video/music footers with the HTTP layer and x402 payment helpers mocked (no network, no real spend); `npm test` now runs with `--experimental-test-module-mocks`.

## 0.25.3

A multi-agent audit pass (finder fan-out across the money path + freshly-merged Solana image code, each finding adversarially verified) surfaced six real issues — all fixed here. Two are budget-gate bypasses on the most-used tools; one is an SSRF deny-list gap. 103 tests (13 new) + typecheck + build + 18-tool stdio smoke green.

- **`fix(chat)` — reserve the frontier worst-case for `balanced`/`coding`/default modes.** `estimateChatCost` only reserved the frontier amount for `reasoning`/`powerful` and explicit models; `balanced` and `coding` fell through to the ~$0.003 budget-model heuristic. But `balanced[0]` = `openai/gpt-5.5` and `coding[0]` = `anthropic/claude-opus-4.8` are frontier, and a no-mode chat resolves to `balanced` — so the **default** chat path reserved 6–20× too little. A near-exhausted budget could authorize a frontier completion, and N concurrent default calls each passed the gate then settled at frontier price, blowing the cap. The ledger (`recordActualSpend`) was already correct; the hole was purely at the pre-call gate.
- **`security(ssrf)` — strip trailing dots so an FQDN can't bypass the deny-list.** `isBlockedFetchHost` matched names exactly or via `endsWith`, but never stripped the root dot the WHATWG URL parser preserves — `new URL("http://metadata.google.internal./").hostname` is `"metadata.google.internal."`, which matched nothing while DNS still resolved it. A prompt-injected `image`/`mask` URL in `blockrun_image` could reach loopback/metadata/internal hosts through this gap.
- **`fix(phone,surf)` — price on a normalized path so a query string can't downgrade the tier.** `estimatePhoneCost`/`estimateSurfCost` classified by exact match on a slug stripped only of a leading slash, so a query string / trailing slash / casing missed the match and priced at the cheap default — `phone/numbers/buy?x=1` billed locally as $0.001 while the gateway charged the real $5, and surf's $0.02 tiers dropped to $0.001. Classification now runs through a shared `normalizeClassifyPath`; the original slug is still sent, so legitimate surf query params are preserved.
- **`fix(image)` — re-reserve the Solana quote against the budget before paying.** On Solana, `blockrun_image` reserved and confirmed the Base cost-table estimate but settled the gateway's marked-up quote, with no re-check — so a call that passed the gate on the low estimate could settle past the cap (`blockrun_video` already guards this). `solanaPaidPost` now exposes the quoted price via an `onQuote` hook before signing; the tool re-reserves the true amount (shared `reReserveIfHigher` helper) and aborts before signing any payment if it would overshoot.
- **`fix(music)` — keep the payment authorization valid through the poll window.** The EIP-3009 authorization was signed with `maxTimeoutSeconds=300`, but after signing the tool waits up to ~95s submit + 240s poll — past 300s. A slow MiniMax track completing after `validBefore` failed settlement server-side and surfaced as a wrong "fund your wallet" error for a track that actually generated. Bumped to `Math.max(server, 600)` (mirrors `blockrun_video`).
- **`fix(speech,music)` — book settled spend before parsing the response body.** On the synchronous settled path a 200 means USDC already left the wallet, but `recordActualSpend` ran only after `resp.json()` and URL validation — so a truncated body threw first, skipped the record, and the `finally` released the reservation, leaving the ledger unchanged for a real charge (the cap silently drifts more permissive). `speech` now books right after confirming the 200; `music`'s inline path parses defensively and records from the receipt before throwing.

## 0.25.2

- **`security(deps)` — patch the `ws` memory-exhaustion DoS chain.** A pinned `viem` transitive `ws@8.20.1` (below the ≥8.21.0 patch) was reaching consumers and flagging the entire `ws → viem → @x402/evm → @blockrun/clawrouter → @blockrun/llm` chain (5 high). An `overrides` entry forces `viem`'s `ws` to 8.21.0, clearing all of them — `npm audit` drops **15 → 11**, the ws chain gone. The override ships in `package.json`, so every `npx` install gets the patched `ws`. The remaining advisories are the Solana web3.js-v1 tree (no upstream fix for `bigint-buffer`; npm's only suggested "fix" is a breaking downgrade), the intentional `rpc-websockets@9.3.0` pin (bumping re-introduces the Node <20.19 ESM break), and a dev-only `esbuild`. Also fixed at the source in **`@blockrun/llm@3.5.1`**. No source changes; 84 tests + build + live wallet smoke green.

## 0.25.1

- **`fix(image)` — validate the env knobs on the 0.25.0 features.** The new opt-in features parsed their numeric env vars with bare `Number(env || default)`, which only falls back on unset/empty (a non-empty string is truthy) — so a typo became `NaN` and silently changed behavior: `BLOCKRUN_CONFIRM_THRESHOLD="$0.05"` flipped the confirm gate to "ask on every paid call", and (fail-open) a malformed `BLOCKRUN_INLINE_MAX_BYTES` removed the inline base64 context-bloat ceiling (`data.length > NaN` is always false). `confirm-spend` now reuses the validated `parseBudgetLimitEnv` (trims, strips a leading `$`, requires a finite positive number); `inline-image` uses a validating `envInt` that falls back to the default on a non-finite/non-positive value and clamps quality to 1–100. Both opt-in and off by default; no behavior change for valid configs.

## 0.25.0

- **`feat(image)` — optional inline preview + opt-in spend confirmation.** Two UX layers for `blockrun_image`, both off by default (no behavior change unless enabled):
  - **Inline preview** — an `inline` param (or `BLOCKRUN_INLINE_IMAGES=1`) returns a downscaled JPEG thumbnail as a `type:"image"` block **alongside** the full-resolution URL, so rich clients (e.g. the VS Code extension) render the result in-conversation. Best-effort: auto-skips above a size cap and on any fetch/encode error (URL-only fallback), with source download/decode caps. Tunable via `BLOCKRUN_INLINE_MAX_DIM` / `_QUALITY` / `_MAX_BYTES`.
  - **Spend confirmation** — before charging, the server asks via **MCP elicitation** (showing the estimated cost) with an "approve all this session" checkbox. **Off by default — opt in with `BLOCKRUN_CONFIRM_SPEND=on`** (avoids double-prompting when a PreToolUse hook already gates spend); threshold via `BLOCKRUN_CONFIRM_THRESHOLD`. No-ops on clients without elicitation and **fails open** — only an explicit *decline* aborts (a decline releases the budget reservation and charges nothing), and session auto-approve latches only on an explicit *accept*.

  Thanks @KillerQueen-Z! (#21) — re-integrated on top of the 0.24.x charge path so the SSRF guard, Content-Length cap, and the concurrency-safe `reserveBudget` reservation all stay intact; the confirmation runs once inside the reserve→record→release flow.

## 0.24.3

A fourth audit pass (regression-hunting the 0.24.1–0.24.2 fixes plus the packaging/build surface) found two issues — both in fixes shipped earlier in the 0.24.x line.

- **`fix(security)` — the image SSRF deny-list no longer misses IPv4-mapped IPv6 literals.** `isBlockedFetchHost` (added in 0.24.1) only decoded the decimal `::ffff:127.0.0.1` form, but the WHATWG URL parser canonicalizes a mapped literal to the hex-compressed form (`new URL('http://[::ffff:127.0.0.1]/').hostname` → `[::ffff:7f00:1]`), which slipped the guard — so `http://[::ffff:169.254.169.254]/` reached the cloud metadata endpoint and `http://[::ffff:127.0.0.1]/` reached loopback. The hex `::ffff:hi:lo` form is now decoded to its embedded IPv4 and re-checked, and the test exercises the hostname `new URL()` actually emits (the prior test only checked the decimal form the real caller never produces).
- **`fix(chat)` — `thinking.budget_tokens` floor is now 1024.** 0.24.2 set the schema floor to 1, but Anthropic's extended thinking requires `≥1024` and the value is forwarded verbatim, so `[1,1023]` always 400'd. The floor matches Anthropic's minimum.

## 0.24.2

A third audit pass — focused on regression-hunting the 0.24.1 changes plus the previously thin Anthropic path, zod schemas, and docs — surfaced a small batch of fixes (one of them a regression introduced by 0.24.1 itself).

- **`fix(chat)` — extended-thinking `budget_tokens` no longer bypasses the budget gate.** The pre-pay reserve was derived from `max_tokens`, but Anthropic bills thinking tokens as output, so a tiny `max_tokens` plus a large `thinking.budget_tokens` passed a ~$0.02 gate while settling for several dollars. The thinking budget is now folded into the reserve, and the param is bounded (`int`, 1–100000) instead of unbounded.
- **`fix(chat)` — native Anthropic data-URI images.** `parseDataUri` only matched `image/{jpeg,png,gif,webp}` with no parameters, so a `data:image/jpg;base64,…` (the common alias) or a URI with `;name=` was forwarded as a `type:"url"` source and 400'd upstream. It now accepts the `jpg` alias and extra params, rejects unsupported media types, skips an unparseable data URI instead of forwarding a broken source, and drops a message whose content reduced to empty.
- **`fix(perf)` — `getChain()` no longer scans the home directory on every call.** 0.24.1's empty-session-file fix switched Solana autodetection to `loadSolanaWallet()`, which `readdir`+`stat`s every hidden dir in `$HOME` — on every `getChain()` call (a hot path hit by every tool, `getWalletInfo`, and `formatError`). It now reads just the session file and requires it non-empty, keeping the guard without the per-call scan.
- **`docs(readme)`** — reconcile with code: Node **≥ 20.19** (was ≥ 18; `engines` requires 20.19), add `blockrun_realface` (enroll/portrait) to both Base-only lists, and note `blockrun_search` covers **X/Twitter** (not just web + news).

## 0.24.1

A second audit pass (every finding adversarially re-verified) over the 0.24.0 code — including the changes 0.24.0 itself introduced — surfaced a batch of hardening fixes. None critical; the two notable ones are residuals of the 0.24.0 budget work.

- **`fix(budget)` — high-resolution video can no longer settle past the cap.** The video pre-pay gate reserved only `perSecond × seconds` (a 720p-baseline estimate); Seedance/Sora are token-priced upstream, so a 1080p/2K/4K render could settle for several multiples of the reserve while the gate only validated the small number. The real price from the 402 challenge is now re-reserved against the budget **before** the payment is signed (and held for the full polling window so concurrent jobs reserve the true amount), aborting if it would exceed the cap.
- **`fix(budget)` — concurrent `blockrun_chat` calls no longer over-count / cross-attribute spend.** `withSettledCost` measured a call's cost as the delta of the shared client's cumulative `getSpending()` counter; under the MCP SDK's concurrent dispatch, two in-flight calls each captured the other's settlement, inflating the ledger and charging agent A for agent B's spend (fail-safe — it never under-counts, so it could not overspend). Each chat call now runs on a fresh per-call client so the delta isolates only that call.
- **`fix(security)` — SSRF guard on the `blockrun_image` reference-URL fetch.** `toImageDataUri` fetched a caller/model-supplied URL server-side with redirects followed and no address filtering, so a supplied (or prompt-injected) reference could probe localhost, the cloud metadata endpoint, or internal hosts. It now rejects loopback/private/link-local/CGNAT/IPv6-ULA addresses and metadata/internal names, and follows redirects manually, re-validating every hop.
- **`fix(robustness)` — bounded fetches, cache + chain-detection edges.** `blockrun_dex` and the Base balance RPC now use bounded fetches (no unbounded hang); the model cache treats an empty catalogue as *not loaded* (an empty result was pinned for the full 5-min TTL); and `getChain` detects Solana via a usable key (`loadSolanaWallet`) instead of bare `existsSync`, so an empty/truncated session file no longer pins every tool to an unbuildable client.
- **`fix(video)` / `docs(constants)`** — the video success message reports the billed duration instead of a hardcoded `8s`, and the OpenAI model-inventory comment now lists `gpt-5.5` (the balanced default) with the correct count.
- **`test`** — +4 suites/cases (68 total): SSRF host classification, model-cache empty-result re-fetch, plus the repurposed image guard test.

## 0.24.0

A whole-codebase audit (8 review angles, every finding adversarially re-verified) found that the v0.23.0 budget cap — the wallet-drain guardrail — had **four independent bypasses**. This release closes all of them plus a batch of correctness and robustness fixes.

- **`fix(security)` — path-based passthrough tools no longer let a `..` segment escape their namespace.** `rpc`, `surf`, `modal`, `phone`, `exa`, `search`, `defi`, and `markets` only stripped leading/trailing slashes, so an internal `..` (or its `%2e%2e` / `.%2e` / backslash encodings, which the WHATWG URL parser normalizes identically) survived — e.g. `blockrun_surf path:"../../v1/phone/numbers/buy"` re-routed onto a $5 endpoint while the ledger booked $0.001, defeating both the per-tool budget pre-check and profile scoping (a `trading`-profile call reaching `/v1/modal/*` or `/v1/phone/*`). New `utils/path-safety` helpers (`hasPathTraversal`, `isValidNetworkSlug`) reject traversal/invalid chain slugs **before** any spend; `blockrun_rpc` validates the network as a plain chain slug (`/^[a-z0-9-]+$/`).
- **`fix(budget)` — the spend cap can no longer be bypassed by concurrent calls (check-then-record TOCTOU).** `checkBudget` only *read* `spent`; the paid call then awaited the network before the spend was *written*, so N concurrent calls each passed a stale total and collectively overran the cap — exactly the multi-agent fan-out the tools advertise. New `reserveBudget()` atomically checks **and** reserves the estimate into `spent`, returning an idempotent `release()` that every paid tool now calls in `finally` once the call settles or fails. The real settled cost is still booked separately; release nets it out. No-charge-on-failure semantics are preserved.
- **`fix(chat)` — `routing:"smart"` + `routing_profile:"free"` no longer drains the wallet unmetered.** That combination reserved `$0` at the gate, but the SDK maps `"free"` → a **paid** auto-tier model, so a loop could spend past the cap with the gate never firing. The `$0` special-case is removed (it now reserves the normal auto amount) and the schema copy that promised "zero cost NVIDIA" is corrected. Also: `response_format:"json_object"` is now honored on the native `anthropic/claude-*` path (folded into a system instruction — `/v1/messages` has no `response_format` field), and `routing:"smart"` combined with a multi-turn `messages` array now returns a clear error instead of silently dropping the conversation history.
- **`fix(errors)` — failures on the manual-402 media tools are classified accurately.** `speech`/`music`/`video`/`realface` probe the endpoint *unpaid* and threw on any non-402 response; the catch matched payment errors by the substring `"402"`/`"payment"`, so a 5xx outage, a 429, or RealFace's 425 (liveness not finished) was reported as "fund your wallet". A new `isPaymentRejectionError` matches only real settlement signals (`insufficient`/`balance`/`rejected`), the probe throws carry no `402`/`payment` tokens, and `formatError`'s status-code regex no longer reads the integer part of a decimal amount (`$402.50`, `$500.00`) as a status code. `music`/`video` also guard the probe-body parse with `.catch(() => ({}))` so a non-JSON error page can't mask the real status.
- **`fix(robustness)` — startup crash, `$NaN` balance, body timeout, image OOM, key-leak gap.** A nonsensical `--profile constructor`/`__proto__` now falls back to `full` (via `Object.hasOwn`) instead of crashing at startup; a lagging RPC returning `{"result":"0x"}` no longer yields `$NaN USDC` and aborting the fallback list (parsed via BigInt, garbage → next RPC); `fetchWithTimeout` keeps its abort timer armed so the timeout covers a body that stalls after headers; a remote reference image is rejected by `Content-Length` before being buffered into memory; and the key-leak scanner now catches a bare (no-`0x`) 64-hex key under a key/secret-named field (MetaMask export format). The duplicated Base USDC address / RPC list in `wallet.ts` is collapsed onto `constants.ts`.
- **`refactor` — dead `ServerContext` type removed; `realface` enroll dedup.** The unused `ServerContext` interface is gone, and the enroll action calls the file's own `payAndPostJson` x402 helper instead of a ~40-line inline copy that had to stay in sync with the portrait path.
- **`test` — 29 new unit tests (64 total).** New suites cover path-safety (incl. percent-encoded/backslash traversal), budget reservation (concurrent gating + idempotent release), `estimateChatCost`/native-JSON, `parseBaseUsdcCallResult`, the body-timeout, the image `Content-Length` pre-check, the key-leak matchers, and the new error-classification cases.

## 0.23.2

- **`fix(errors)` — error guidance no longer suggests a wrong, cross-domain model, and upstream model outages are classified as such instead of a generic blip.** `formatError` (shared by all tools) had a single 500 branch that appended *"try a different model (e.g. openai/gpt-4o)"* — useless advice on a video/image/music/speech failure, and wrong when the gateway surfaced an upstream model-supply outage (token360's `Model '…' not found or not active for requested provider`) as a 500. A new `isModelUnavailable` branch detects that case and says the model is *temporarily unavailable upstream*; an optional `altModels` lets a tool name a **same-domain** fallback (video → `bytedance/seedance-2.0, azure/sora-2`; image → `google/nano-banana, zai/cogview-4`, each spanning two providers so a single-provider outage still leaves a working suggestion). Music/speech/other tools simply stop emitting the wrong model name. Thanks @KillerQueen-Z! (#26)
- **`test` — `formatError` branch coverage.** `test/errors.test.ts` covers model-unavailable (with and without `altModels`), the generic-500 path no longer naming `gpt-4o`, payment/402 funding guidance, plain validation messages getting no canned text, and the `$1.4020`-isn't-a-402 token-boundary guard.

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
