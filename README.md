# BlockRun MCP

[![npm](https://img.shields.io/npm/v/@blockrun/mcp)](https://www.npmjs.com/package/@blockrun/mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-compatible-blue)](https://modelcontextprotocol.io)

**Real-time data for Claude — markets, research, X/Twitter, crypto. No API keys. Pay per call.**

```bash
claude mcp add blockrun -s user -- npx -y @blockrun/mcp@latest
```

Wallet auto-created. Fund with $5 USDC. Ask Claude anything.

---

## What changes

Before BlockRun, Claude can't answer:

- *"What's the current Polymarket probability that Bitcoin hits $100k this year?"*
- *"Find me the top 5 papers on RAG published in the last 30 days"*
- *"What are people saying about @sama on X right now?"*
- *"What's the 24h volume on the PEPE/ETH pair on Uniswap?"*

After BlockRun, it can. Each query costs fractions of a cent, billed from a local USDC wallet. No subscriptions. No API dashboards. No key rotation.

---

## Demo

> **User:** What's Polymarket saying about the Fed rate decision next month?

> **Claude:** According to Polymarket, the market currently puts a **73% probability** on the Fed holding rates steady at the May meeting, with 24% on a 25bp cut and 3% on a hike. Volume over the last 24h: $2.1M. The "Hold" contract last traded at $0.73.
>
> *(via `blockrun_markets` · cost: $0.001)*

---

> **User:** Find recent papers on speculative decoding and summarize the key approaches

> **Claude:** I found 8 papers from the last 60 days via neural search. The dominant approaches are: (1) draft model selection — smaller models predicting N tokens ahead for the larger model to verify in parallel...
>
> *(via `blockrun_exa` · cost: $0.01)*

---

## Showcase

Posters generated through `blockrun_image` with `openai/gpt-image-2`. Each is a single API call routed through BlockRun, paid in USDC on Base.

### Latest — GPT-5.5 now live on BlockRun

<p align="center">
  <img src="assets/posters/gpt-5-5-launch.png" width="640" alt="gpt-5.5 — now live on BlockRun. Pay per call. No subscription. No keys.">
</p>

### Gallery

| | | |
|:---:|:---:|:---:|
| <img src="assets/posters/cornell-2026-popular-booth.png" width="280" alt="Thank you, Cornell — BlockRun at the Cornell Blockchain Conference 2026, packed booth"> | <img src="assets/posters/cornell-2026.png" width="280" alt="Thank you, Cornell — BlockRun at the Cornell Blockchain Conference 2026"> | <img src="skills/image-prompting/example-100t-poster.jpg" width="280" alt="100 Trillion Tokens served — synthwave milestone poster"> |
| **Cornell Blockchain Conference 2026** — packed booth recap | **Cornell Blockchain Conference 2026** — quiet variant | **100 Trillion Tokens** — milestone synthwave poster |

Prompts and a worked example for these are in [`skills/image-prompting/SKILL.md`](skills/image-prompting/SKILL.md).

---

## Prerequisites

- **Node.js ≥ 18** (`node -v`)
- **~$5 USDC** on Base or Solana (the server auto-creates a wallet on first run; see [Fund your wallet](#fund-your-wallet))
- **An MCP client**: Claude Code, Claude Desktop, Cursor, Windsurf, or ChatGPT Desktop

---

## Install

**Claude Code (recommended)**
```bash
claude mcp add blockrun -s user -- npx -y @blockrun/mcp@latest
```

The `-s user` flag installs globally (available in every project). The `--` separator
ensures `-y` is passed to `npx`, not parsed by `claude mcp add`.

**Claude Desktop** — add to `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "blockrun": {
      "command": "npx",
      "args": ["-y", "@blockrun/mcp"]
    }
  }
}
```

**Cursor** — add to `~/.cursor/mcp.json` (macOS / Linux) or `%APPDATA%\Cursor\mcp.json` (Windows):
```json
{
  "mcpServers": {
    "blockrun": {
      "command": "npx",
      "args": ["-y", "@blockrun/mcp@latest"]
    }
  }
}
```

**Windsurf** — same JSON, in:
- macOS: `~/.codeium/windsurf/mcp_config.json`
- Linux: `~/.config/.codeium/windsurf/mcp_config.json`
- Windows: `%APPDATA%\Codeium\windsurf\mcp_config.json`

---

## Fund your wallet

Run `blockrun_wallet` to see your address. The server pays on **Base** by default. Send USDC on Base:

| Method | Steps |
|--------|-------|
| Coinbase | Send → USDC → Base network → paste address |
| Bridge from Ethereum | [bridge.base.org](https://bridge.base.org) |

$5 covers ~5,000 market queries, ~500 Exa searches, ~250 image generations, or ~10 Seedance 1.5-pro clips (5s @ 720p+audio, ~$0.46 each).

### Pay on Solana

Prefer to pay in USDC on Solana? It's two tool calls — no env vars, no file editing, no restart:

```
blockrun_wallet action:"chain" chain:"solana"   # provisions + activates the Solana wallet
blockrun_wallet action:"setup"                  # shows the Solana address + funding QR
```

Then send USDC (SPL) on the **Solana** network — from Coinbase (pick "Solana"), Phantom, Solflare, or Backpack. Switch back anytime with `blockrun_wallet action:"chain" chain:"base"`. The server keeps both wallets; switching just changes which one pays.

**Base-only — these fall back to Base regardless of active chain:**

- Tools: `blockrun_image`, `blockrun_music`, `blockrun_speech`, `blockrun_video`, paid stock `blockrun_price`. In Solana mode they return a "switch to Base" message instead of charging.
- `blockrun_chat routing:"smart"` (ClawRouter) and native Anthropic (`claude-*`) passthrough — on Solana, pass `model:` or `mode:` explicitly.

> Advanced: chain selection can also be forced before startup via files/env (`~/.blockrun/.chain`, `SOLANA_WALLET_KEY`) — see [Environment Variables](#environment-variables). The `action:"chain"` command above is the recommended path.

---

## Tools

| Tool | Data source | Cost |
|------|-------------|------|
| `blockrun_chat` | 66+ LLMs (GPT, Claude, Gemini, DeepSeek, Kimi K2.6, GLM, NVIDIA free tier, ...) with `mode` tier routing | per token |
| `blockrun_image` | GPT Image 1/2, Nano Banana / Pro (up to 4K), Grok Imagine, CogView-4 — generation + img2img editing | $0.015–0.15 |
| `blockrun_video` | Sora 2 + xAI Grok Imagine Video + ByteDance Seedance 1.5/2.0/2.0-fast (720p + audio defaults); RealFace asset → real-person video | $0.05–0.30/sec |
| `blockrun_realface` | Enroll a real person (phone liveness) or an AI character (Virtual Portrait, no liveness) as a `ta_xxxx` asset for Seedance 2.0 video | free; $0.01 to enroll |
| `blockrun_music` | MiniMax music generation | per track |
| `blockrun_speech` | ElevenLabs text-to-speech (Flash/Turbo/Multilingual/v3, 8 voice aliases) + cinematic sound effects; free voice listing | $0.05–0.10/1k chars; $0.0525/effect |
| `blockrun_price` | Pyth-backed realtime + OHLC — crypto / FX / commodity (free), 12 stock markets (paid) | free or $0.001/call |
| `blockrun_markets` | Polymarket (markets, candles, trades, orderbooks, leaderboards, smart-wallet PnL/clusters, UMA oracle), Kalshi, Limitless, Opinion, Predict.Fun, dFlow, Binance Futures, cross-platform match + search | $0.001–0.005/query |
| `blockrun_surf` | Surf (asksurf.ai) — 84 endpoints: CEX market data, on-chain SQL (13 chains, 80+ ClickHouse tables), 100M+ labeled wallets, Polymarket + Kalshi side-by-side, social mindshare, news, search, Surf-1.5 chat with citations | $0.001–0.02/call |
| `blockrun_exa` | Neural web search (Exa) — research, competitors, papers, URL content | $0.01/query |
| `blockrun_search` | Grok Live Search — web + news with citations | $0.025 × max_results (default 10) |
| `blockrun_dex` | Live DEX prices via DexScreener | free |
| `blockrun_rpc` | Raw JSON-RPC on 40+ chains (Ethereum, Base, Solana, Bitcoin, Sui, NEAR, ...) via Tatum gateway — eth_call, balances, blocks, logs | $0.002/call |
| `blockrun_defi` | DefiLlama — protocol TVL, chain TVL, yield pools (APY), token prices | $0.001–0.005/call |
| `blockrun_modal` | Isolated code execution in a BlockRun-hosted Modal sandbox — disposable container, optional GPU (T4 → H100) | $0.01 create; $0.001/op |
| `blockrun_phone` | Outbound AI voice calls (Bland) + wallet-owned US/CA numbers (Twilio), carrier + fraud lookups | $0.54/call; $5/number |
| `blockrun_models` | Live catalogue of every LLM/image/video/music model + pricing | free |
| `blockrun_wallet` | Balance, spending, agent budgets, setup QR | free |

---

## Tips for effective LLMs

> **For LLMs and agents invoking BlockRun MCP tools:**

- **CRITICAL: When any `blockrun_*` tool returns a payment / balance / 402 error, call `blockrun_wallet` *first* to check status, then `action:"setup"` to get funding instructions.** Don't retry the failing tool blindly — the wallet is empty.
- **CRITICAL: For `blockrun_markets` and `blockrun_surf`, the 80+ endpoint catalog lives in `skills/markets/SKILL.md` and `skills/surf/SKILL.md`, NOT in the tool description.** Browse the skill before guessing endpoint paths.
- **CRITICAL: `blockrun_chat routing:"smart"` (ClawRouter) only works on Base wallets.** On Solana, pass `mode:` or `model:` to pick a model directly.
- **CRITICAL: `blockrun_music` and `blockrun_video` are payment-on-completion async.** Failures or client-side timeouts do NOT charge. Don't retry-loop them — they may take 60–180s.
- **CRITICAL: Before spawning child agents, allocate per-agent budget:** `blockrun_wallet action:"delegate" agent_id:"X" agent_limit:1.00`. Pass `agent_id:"X"` to every downstream `blockrun_*` call — the child is auto-blocked when the budget hits zero.
- **Free tier first for drafts**: `blockrun_chat mode:"free"` (NVIDIA), `blockrun_dex`, `blockrun_price` (crypto / FX / commodity), and `blockrun_models` are all $0. Use them to scaffold before paying for premium models.

---

## Key Use Cases

What kinds of questions can Claude (or any LLM agent) answer once BlockRun MCP is installed:

1. **Price reads / market data**
   > *"What's BTC trading at? Compare with last week's average."* → `blockrun_price` (free) or `blockrun_surf` path:`market/price`

2. **Prediction-market consensus**
   > *"What's Polymarket's odds for the next Fed rate decision?"* → `blockrun_markets` path:`polymarket/events` + filter

3. **On-chain forensics**
   > *"This wallet (0xabc...) — what's it labeled as? What does it hold? When did it whale up?"* → `blockrun_surf` paths:`wallet/labels/batch`, `wallet/detail`, `wallet/net-worth`

4. **Cited research with sources**
   > *"Find the 5 most-cited papers on speculative decoding from the last 90 days. Summarize the dominant approach."* → `blockrun_exa` action:`search` then `contents`

5. **Image generation with on-image text**
   > *"Generate a poster announcing GPT-5.5 on BlockRun, retro-futuristic, with the headline 'NOW LIVE'."* → `blockrun_image` + the `image-prompting` skill 5-section framework

6. **Give your agent a voice**
   > *"Use blockrun to speak this with the sarah voice."* → `blockrun_speech` action:`speak` (default), `input` + `voice` → hosted MP3 URL. Sound effects via action:`sound_effect`

7. **Voice phone-out**
   > *"Call +1-415-555-... and confirm the appointment on Friday at 3pm."* → `blockrun_phone` path:`voice/call`, body: `{ to, task, from }` (provision `from` first via `phone/numbers/buy`), then poll `voice/call/{call_id}`

8. **Multi-agent research with budget cap**
   > *"Spawn 3 research agents on competing L1 narratives. Cap each at $0.50."* → `blockrun_wallet delegate × 3` → children call `blockrun_chat` + `blockrun_exa` with their `agent_id`

9. **Cross-chain SQL forensics**
   > *"Top 10 tokens by DEX volume on Base in the last 24h."* → `blockrun_surf` path:`onchain/sql`, body: `{ sql: "SELECT..." }`

---

## Why not just use the APIs directly?

| | Direct APIs | BlockRun |
|---|---|---|
| Exa | Sign up, $20/mo minimum | $0.01/call, no subscription |
| Polymarket | Undocumented, rate-limited | $0.001/call, clean JSON |
| Surf (asksurf.ai) | Account + monthly plan | $0.001/call, no Surf account, 84 endpoints |
| Multiple sources | 3 accounts, 3 API keys, 3 billing pages | 1 wallet |

One wallet. All sources. No dashboards.

---

## When NOT to use BlockRun MCP

BlockRun shines when you want **unified billing + many sources + LLM-readable errors**. It is not the right fit for:

- **High-volume single-API workloads (≥10k calls/day to one source).** Direct subscriptions amortize better past the break-even point — Polymarket's free public API plus your own caching beats $0.001 × 10k/day if you don't need cross-source aggregation.
- **Compliance-sensitive flows that need a fiat invoice / audit trail.** BlockRun settles in USDC; receipts are on-chain (Basescan / Solscan) but are not tax invoices. For enterprise procurement, contract directly with the upstream provider.
- **Latency-critical sub-100ms reads.** Each x402 call adds ~200–500ms of payment-signing + settlement overhead vs. a direct authenticated request. For HFT-style flows, run your own infra.
- **You only need one source forever.** If you'll only ever call Polymarket, or only ever Exa, save the indirection — sign up upstream and skip the wallet.

Use BlockRun when you want pay-per-call for *exploration*, *aggregation*, or *agent-driven* workloads where you can't predict which source you'll reach for next.

---

## Multi-agent budget delegation

Delegate a spending budget to a child agent with `agent_id`. The child is auto-blocked when the budget runs out — useful for autonomous agents that shouldn't run up unbounded costs.

---

## Troubleshooting

- **`Insufficient balance` / HTTP 402 after retry** → Run `blockrun_wallet action:"setup"`. Send USDC on Base (or Solana — see [Environment Variables](#environment-variables)).
- **`Smart routing (ClawRouter) is not available on Solana`** → Pass `model:` or `mode:` explicitly to `blockrun_chat`, or switch back to Base with `echo base > ~/.blockrun/.chain`.
- **`claude mcp list` doesn't show `blockrun`** → Check `node -v` (must be ≥18). Clear the npx cache: `rm -rf ~/.npm/_npx`. Re-run the install command from above.
- **`fetch failed` / timeout when checking wallet balance** → Base RPC transient outage. The tool already falls through 3 public RPCs; retry after 30s. Persistent failures usually = local proxy / firewall blocking outbound RPC.
- **`ENOENT: ~/.blockrun/.session`** → Expected on first run. The server auto-creates the wallet; check stderr for the `WALLET_CREATED` line confirming the address.
- **`Video generation timed out` (5-min cap)** → Upstream Seedance / xAI queue congestion. **No charge** (payment-on-completion). Retry, or pick a faster model (`bytedance/seedance-1.5-pro`).
- **`Music generation timed out` (200s cap)** → Same pattern. **No charge**. Retry; if it persists, the upstream model is rate-limited — try off-peak.

---

## Environment Variables

| Variable / File | Default | Effect |
|---|---|---|
| `~/.blockrun/.session` | auto-created on first run | EVM private key (0x...). File exists → use Base. |
| `~/.blockrun/.chain` | unset | Optional explicit chain preference: `base` or `solana`. |
| `~/.blockrun/.solana-session` | not created | Solana private key. File exists → switch to Solana unless `.chain` says `base`. |
| `SOLANA_WALLET_KEY` | unset | Env-var override of `.solana-session`. Set → use Solana. |

Chain selection priority (see `src/utils/wallet.ts`):

1. `~/.blockrun/.chain` or `~/.blockrun/payment-chain` set to `base` or `solana` → explicit preference wins
2. `SOLANA_WALLET_KEY` env var present → Solana
3. `~/.blockrun/.solana-session` exists → Solana
4. Otherwise → Base (`~/.blockrun/.session` auto-created)

**Switching chains:**

The recommended way is the tool itself — it provisions both wallets, applies instantly (no restart), and shows the funding QR:

```
blockrun_wallet action:"chain" chain:"solana"   # or chain:"base"
blockrun_wallet action:"setup"                  # funding instructions for the active chain
```

*Advanced (force a chain before startup, e.g. in CI):* `echo solana > ~/.blockrun/.chain` then set `SOLANA_WALLET_KEY` or create `~/.blockrun/.solana-session`; `echo base > ~/.blockrun/.chain` reuses the existing `.session` (same Base wallet). These edit the same preference file that `action:"chain"` writes — prefer the tool unless you need pre-startup control.

Some media and paid market-data tools still settle on Base only: `blockrun_image`, `blockrun_music`, `blockrun_speech`, `blockrun_video`, and paid stock `blockrun_price` calls — plus `blockrun_chat routing:"smart"` and native Anthropic (`claude-*`) passthrough. In Solana mode these return a "switch to Base" message instead of charging.

The server also runs a non-blocking npm registry check at startup and prints an `Update available` notice to stderr when a newer `@blockrun/mcp` version exists. Upgrade by re-running the install command — no manual `npm update` needed.

---

## How it works

Pay-per-call via [x402](https://x402.org) micropayments in USDC. Your wallet lives at `~/.blockrun/.session` (Base) or `~/.blockrun/.solana-session` (Solana). The private key never leaves your machine.

---

## Contributing

PRs welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, the tool-vs-skill design rule, and how to add a new partner API.

Issues: [github.com/blockrunai/blockrun-mcp/issues](https://github.com/blockrunai/blockrun-mcp/issues)

---

[blockrun.ai](https://blockrun.ai) · [npm](https://www.npmjs.com/package/@blockrun/mcp) · [@BlockRunAI](https://x.com/BlockRunAI)
