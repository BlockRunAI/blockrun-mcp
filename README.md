<div align="center">

<h1>BlockRun MCP</h1>

<h3>Real-time data — and real trades — for Claude and any AI agent.</h3>

<p>Agents can't sign up for accounts. Agents can't enter credit cards.<br>
Agents can only sign transactions.<br><br>
<strong>BlockRun MCP gives your agent <!-- br:mcp.tools -->20<!-- /br:mcp.tools --> tools — markets, research, web search, images, video, on-chain data, and live Polymarket trading — paid per call in USDC. No accounts. No API keys. No dashboards.</strong><br><br>
<em>Read the odds <strong>and</strong> place the bet, from one self-custody wallet.</em></p>

<br>

<img src="https://img.shields.io/badge/🧰_20_Tools-success?style=for-the-badge" alt="20 tools">&nbsp;
<img src="https://img.shields.io/badge/🤖_Agent--Native-black?style=for-the-badge" alt="Agent native">&nbsp;
<img src="https://img.shields.io/badge/🔑_Zero_API_Keys-blue?style=for-the-badge" alt="No API keys">&nbsp;
<img src="https://img.shields.io/badge/📈_Read_+_Trade_Polymarket-e11d48?style=for-the-badge" alt="Read and trade Polymarket">&nbsp;
<img src="https://img.shields.io/badge/💰_x402_USDC-purple?style=for-the-badge" alt="x402 USDC">&nbsp;
<img src="https://img.shields.io/badge/🔓_Open_Source-green?style=for-the-badge" alt="Open source">

[![npm version](https://img.shields.io/npm/v/@blockrun/mcp.svg?style=flat-square&color=cb3837)](https://www.npmjs.com/package/@blockrun/mcp)
[![npm downloads](https://img.shields.io/npm/dm/@blockrun/mcp.svg?style=flat-square&color=blue)](https://www.npmjs.com/package/@blockrun/mcp)
[![GitHub stars](https://img.shields.io/github/stars/BlockRunAI/blockrun-mcp?style=flat-square&label=GitHub%20stars)](https://github.com/BlockRunAI/blockrun-mcp)
[![Publish](https://img.shields.io/github/actions/workflow/status/BlockRunAI/blockrun-mcp/publish.yml?branch=main&style=flat-square&label=publish)](https://github.com/BlockRunAI/blockrun-mcp/actions)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178c6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Node](https://img.shields.io/badge/Node-%E2%89%A520.19-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-green?style=flat-square)](LICENSE)

[![MCP](https://img.shields.io/badge/MCP-compatible-000000?style=flat-square)](https://modelcontextprotocol.io)
[![x402 Protocol](https://img.shields.io/badge/x402-Micropayments-purple?style=flat-square)](https://x402.org)
[![Base Network](https://img.shields.io/badge/Base-USDC-0052FF?style=flat-square&logo=coinbase&logoColor=white)](https://base.org)
[![Solana](https://img.shields.io/badge/Solana-USDC-9945FF?style=flat-square&logo=solana&logoColor=white)](https://solana.com)
[![Telegram](https://img.shields.io/badge/Telegram-Community-26A5E4?style=flat-square&logo=telegram)](https://t.me/blockrunAI)

</div>

```bash
claude mcp add blockrun -s user -- npx -y @blockrun/mcp@latest
```

<div align="center"><em>Wallet auto-created on first run. Fund with $5 USDC. Ask Claude anything.</em></div>

---

> **BlockRun MCP** is an open-source [Model Context Protocol](https://modelcontextprotocol.io) server that gives Claude — and any MCP-compatible agent — <!-- br:mcp.tools -->20<!-- /br:mcp.tools --> tools for real-time data and real actions: <!-- br:models.chatVisible -->66<!-- /br:models.chatVisible --> LLMs, image & video generation, prediction-market data, live web/X search, on-chain queries across <!-- br:chains.rpc -->40<!-- /br:chains.rpc --> chains, and **the ability to place real, USDC-settled bets on Polymarket**. Authentication is a wallet signature (no API keys); you pay per call in USDC via the [x402](https://x402.org) protocol (no credit cards, no subscriptions). One self-custody wallet on Base or Solana. MIT licensed.

## 🏆 First of its kind — the signal → trade loop in Claude Code

Read live Polymarket odds *and* place the bet, from one self-custody wallet, pay-per-call. [Jump to Polymarket trading →](#-polymarket-trading)

---

## Why BlockRun MCP exists

Every other data integration was built for **human developers** — create an account, copy an API key into `.env`, add a credit card, repeat for every vendor.

**Agents can't do any of that.** BlockRun MCP is built for the agent-first world:

- **One wallet, every source** — <!-- br:mcp.tools -->20<!-- /br:mcp.tools --> tools behind a single self-custody wallet. No per-vendor signups.
- **No API keys** — your wallet signature *is* authentication.
- **No credit cards** — pay per request in USDC via [x402](https://x402.org), fractions of a cent each.
- **Starts free** — the free tier (`blockrun_chat mode:"free"`, `blockrun_dex`, crypto `blockrun_price`, `blockrun_models`) costs $0.
- **Reads *and* acts** — most tools deliver data; `blockrun_polymarket` places real, confirm-gated trades.
- **Self-custody** — your key never leaves your machine (`~/.blockrun/.session` by default, `0600`). BlockRun can't move your funds.

---

## How it compares

|                     | Raw provider APIs                | Typical single-vendor MCP | **BlockRun MCP**                          |
| ------------------- | -------------------------------- | ------------------------- | ----------------------------------------- |
| **Setup**           | Account + API key *per vendor*   | Account/key for 1 vendor  | **Wallet auto-created, no signup**        |
| **Payment**         | Credit card, monthly minimums    | Credit card / vendor plan | **USDC per-call via x402**                |
| **Data sources**    | One per integration              | One vendor                | **<!-- br:mcp.tools -->20<!-- /br:mcp.tools --> tools — LLMs, media, markets, chain**|
| **Place real bets** | Build it yourself                | Rare                      | **Yes — Polymarket CLOB, confirm-gated**  |
| **Pay-chain**       | —                                | —                         | **Base + Solana**                         |
| **Agent budgets**   | Manual                           | —                         | **Built-in per-agent delegation**         |
| **Open source**     | Varies                           | Varies                    | **Yes (MIT)**                             |

✓ One wallet · ✓ Pay-per-call · ✓ Reads **and** trades · ✓ Multi-chain · ✓ Agent-ready · ✓ Open source

---

## What changes

Before BlockRun, Claude can't answer:

- *"What's the current Polymarket probability that Bitcoin hits $100k this year?"*
- *"Find me the top 5 papers on RAG published in the last 30 days."*
- *"What are people saying about @sama on X right now?"*
- *"What's the 24h volume on the PEPE/ETH pair on Uniswap?"*
- *"Polymarket has the Fed holding at 73% — put $2 on it."* ← and now it can **place the trade**, not just read the odds.

After BlockRun, it can. Each query costs fractions of a cent, billed from a local USDC wallet. No subscriptions. No API dashboards. No key rotation.

---

## Quick Start

### 1. Install

**Claude Code (recommended)**

```bash
claude mcp add blockrun -s user -- npx -y @blockrun/mcp@latest
```

`-s user` installs globally (available in every project). The `--` separator ensures `-y` is passed to `npx`, not parsed by `claude mcp add`.

> 💡 **Homebrew / nvm users:** if the server doesn't connect, Claude Code likely can't find `node`/`npx` on its launcher PATH. Pass your shell PATH through — works on CLI and desktop:
> ```bash
> claude mcp add blockrun -s user -e PATH="$PATH" -- npx -y @blockrun/mcp@latest
> ```
> See [Troubleshooting](#troubleshooting) if it persists.

<details>
<summary><strong>Other clients — Claude Desktop, Cursor, Windsurf</strong></summary>

**Claude Desktop** — add to `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "blockrun": { "command": "npx", "args": ["-y", "@blockrun/mcp"] }
  }
}
```

**Cursor** — add to `~/.cursor/mcp.json` (macOS/Linux) or `%APPDATA%\Cursor\mcp.json` (Windows):
```json
{
  "mcpServers": {
    "blockrun": { "command": "npx", "args": ["-y", "@blockrun/mcp@latest"] }
  }
}
```

**Windsurf** — same JSON, in:
- macOS: `~/.codeium/windsurf/mcp_config.json`
- Linux: `~/.config/.codeium/windsurf/mcp_config.json`
- Windows: `%APPDATA%\Codeium\windsurf\mcp_config.json`

</details>

### 2. Choose a tool profile (optional)

Expose a trimmed tool set so the client loads fewer schemas into context. Pass `--profile <name>` (or set `BLOCKRUN_MCP_PROFILE`); omit for the full set.

| Profile | Tools |
|---------|-------|
| `full` *(default)* | everything (<!-- br:mcp.tools -->20<!-- /br:mcp.tools --> tools) |
| `media` | `wallet` `models` `image` `video` `realface` `music` `speech` |
| `trading` | `wallet` `price` `dex` `markets` `surf` `defi` `rpc` `polymarket_read` `polymarket` |
| `research` | `wallet` `models` `chat` `search` `exa` `surf` |
| `chat` | `wallet` `models` `chat` |

```bash
claude mcp add blockrun-trading -s user -- npx -y @blockrun/mcp@latest --profile trading

# Codex CLI
codex mcp add blockrun-trading -- npx -y @blockrun/mcp@latest --profile trading
```

An unknown profile name falls back to `full`. `modal` and `phone` are `full`-profile only.
For a complete live signal → order-preview presentation, use
[`skills/signal-to-trade-demo/SKILL.md`](skills/signal-to-trade-demo/SKILL.md)
with the [Stanford runbook](docs/stanford-trading-demo.md).

### 3. Fund your wallet

Run `blockrun_wallet` to see your address. The server pays on **Base** by default — send USDC on Base (Coinbase → USDC → Base network → paste address, or bridge via [bridge.base.org](https://bridge.base.org)).

**$5 covers** ~525 market queries · ~500 Exa searches · ~250 image generations · ~10 Seedance 1.5-pro clips.

Prefer Solana? See [Fund your wallet](#fund-your-wallet) — two tool calls, no restart.

### 4. Ask Claude anything

> *"What's Polymarket saying about the next Fed decision? If 'hold' is above 70%, put $2 on it."*

Claude reads the odds with `blockrun_markets` and — with your confirmation — places the trade with `blockrun_polymarket`. One wallet. Gasless. Confirm-gated.

---

## Demo

> **User:** What's Polymarket saying about the Fed rate decision next month?

> **Claude:** According to Polymarket, the market puts a **73% probability** on the Fed holding rates steady, 24% on a 25bp cut, 3% on a hike. 24h volume: $2.1M. The "Hold" contract last traded at $0.73.
>
> *(via `blockrun_markets` · cost: $0.0095)*

---

> **User:** Polymarket has Hawley at ~13% to announce a 2026 presidential run — put $1 on Yes.

> **Claude:** Done — bought **7.63 shares of Yes at $0.131** ($1.00, market FOK). Real on-chain order, settled in pUSD from your gasless Polymarket deposit wallet; I'm tracking the position now.
>
> *(signal via `blockrun_markets`, trade via `blockrun_polymarket` — one self-custody wallet, gasless · on-chain tx `0x7ca8…`)*

---

## Tools

| Tool | Data source | Cost |
|------|-------------|------|
| `blockrun_chat` | <!-- br:models.chatVisible -->66<!-- /br:models.chatVisible --> LLMs (GPT, Claude, Gemini, DeepSeek, Kimi K3, GLM, NVIDIA free tier, …) with `mode` tier routing | per token |
| `blockrun_image` | Generate: openai/gpt-image-2, gpt-image-1, google/nano-banana(-pro), xai/grok-imagine-image(-pro), zai/cogview-4. Edit: img2img, inpaint, fusion. | $0.015–0.15 |
| `blockrun_video` | Sora 2 + xAI Grok Imagine Video + ByteDance Seedance 1.5/2.0/2.0-fast (720p + audio); RealFace asset → real-person video | $0.05–0.30/sec |
| `blockrun_realface` | Enroll a real person (phone liveness) or AI character (Virtual Portrait) as a `ta_xxxx` asset for Seedance 2.0 video | free; $0.01 to enroll |
| `blockrun_music` | MiniMax music generation | per track |
| `blockrun_speech` | ElevenLabs TTS (Flash/Turbo/Multilingual/v3, 8 voices) + cinematic sound effects; free voice listing | $0.05–0.10/1k chars |
| `blockrun_price` | Pyth-backed realtime + OHLC — crypto / FX / commodity (free), 12 stock markets (paid) | free or $0.001/call |
| `blockrun_markets` | Polymarket (markets, candles, trades, orderbooks, leaderboards, smart-wallet PnL/clusters, UMA oracle), Kalshi, Limitless, Opinion, Predict.Fun, dFlow, Binance Futures, cross-platform search | $0.0095/query |
| `blockrun_polymarket_read` | Read-only Polymarket positions/open orders plus executable live order previews, separated for MCP clients that enforce tool safety annotations | free |
| `blockrun_polymarket` | **Trade on Polymarket** (CLOB V2): place/cancel real bets, positions, redeem winnings — signed locally, settled in pUSD from a gasless deposit wallet. Confirm-gated, $25/order default cap. [Details ↓](#-polymarket-trading) | free tool; bets are your funds |
| `blockrun_surf` | Surf (asksurf.ai) — 83 endpoints: CEX data, on-chain SQL (13 chains, 80+ tables), 100M+ labeled wallets, Polymarket + Kalshi, social mindshare, news, Surf-1.5 chat with citations | $0.0095/call |
| `blockrun_exa` | Neural web search (Exa) — research, competitors, papers, URL content | $0.01/query |
| `blockrun_search` | Grok Live Search — web + X/Twitter + news with citations | $0.025 × max_results |
| `blockrun_dex` | Live DEX prices via DexScreener | free |
| `blockrun_rpc` | Raw JSON-RPC on <!-- br:chains.rpc -->40<!-- /br:chains.rpc --> chains (Ethereum, Base, Solana, Bitcoin, Sui, NEAR, …) via Tatum | $0.002/call |
| `blockrun_defi` | DefiLlama — protocol TVL, chain TVL, yield pools (APY), token prices | $0.001–0.005/call |
| `blockrun_modal` | Isolated code execution in a BlockRun-hosted Modal sandbox — disposable container, optional GPU (T4 → H100) | $0.01 create; $0.001/op |
| `blockrun_phone` | Outbound AI voice calls (Bland) + wallet-owned US/CA numbers (Twilio), carrier + fraud lookups | $0.54/call; $5/number |
| `blockrun_models` | Live catalogue of every LLM/image/video/music model + pricing | free |
| `blockrun_wallet` | Balance, spending, agent budgets, setup QR, chain switch | free |

---

## Key use cases

1. **Prediction-market consensus** → *"Polymarket's odds for the next Fed decision?"* — `blockrun_markets`
2. **Signal → trade** *(the full loop, self-custody)* → *"If 'hold' is under 30%, put $2 on Yes."* — `blockrun_markets` reads, `blockrun_polymarket action:"buy"` places. Gasless, confirm-gated.
3. **On-chain forensics** → *"This wallet — what's it labeled, what does it hold, when did it whale up?"* — `blockrun_surf`
4. **Cited research** → *"5 most-cited papers on speculative decoding, last 90 days."* — `blockrun_exa`
5. **Image generation with on-image text** → *"Poster announcing GPT-5.5, retro-futuristic, headline 'NOW LIVE'."* — `blockrun_image`
6. **Give your agent a voice** → *"Speak this with the sarah voice."* — `blockrun_speech`
7. **Voice phone-out** → *"Call +1-415-… and confirm Friday at 3pm."* — `blockrun_phone`
8. **Multi-agent research, capped** → *"Spawn 3 agents on competing L1 narratives. Cap each at $0.50."* — `blockrun_wallet delegate × 3`
9. **Cross-chain SQL** → *"Top 10 tokens by DEX volume on Base, last 24h."* — `blockrun_surf` `onchain/sql`

---

## 📈 Polymarket trading

`blockrun_polymarket` lets an agent place **real bets** on [Polymarket](https://polymarket.com) (CLOB V2, Polygon). It is **non-custodial**: every order and approval is EIP-712-signed locally by your BlockRun wallet key — the same self-custody key that pays x402 API fees on Base also authorizes bets on Polygon. Neither BlockRun nor Polymarket's relayer can move funds; they only forward payloads you signed.

**Architecture** — the official "deposit wallet" path (signature type POLY_1271): a smart-contract vault on Polygon, CREATE2-derived from your key (only your key can authorize it), holds betting funds in **pUSD** (Polymarket's 1:1 collateral wrapper). Deployment, approvals, and redemptions all run **gasless** through Polymarket's relayer — you never need POL.

**📖 Full step-by-step guide:** [`docs/polymarket-trading-setup.md`](docs/polymarket-trading-setup.md)

```
# 1. Provision your deposit wallet (idempotent, gasless)
blockrun_polymarket action:"setup"

# 2. Fund it from your Base USDC in one call (gasless; $0.01 fee, non-custodial)
blockrun_polymarket action:"fund" amount_usd:5 confirm:true

# 3. Sign the one-time gasless approval batch
blockrun_polymarket action:"setup" confirm:true

# 4. Find a market, preview safely, then place only after exact user approval
blockrun_polymarket_read action:"preview" side:"buy" token_id:"<id>" amount_usd:5 order_type:"FOK"
blockrun_polymarket action:"buy" token_id:"<id>" amount_usd:5 order_type:"FOK" confirm:true

# 5. Manage → positions · orders · cancel · sell · redeem · withdraw
```

**Safety rails** (server-side; an agent cannot bypass them): `confirm:true` required for every order/approval/redeem, `POLYMARKET_MAX_BET_USD` per-order cap (default $25), optional `POLYMARKET_MAX_SESSION_USD` session cap, and bets never draw from the x402 API budget.

**Regions:** Polymarket geoblocks order placement by IP (US/UK + many regions). **Handled by default** — the MCP routes CLOB traffic through BlockRun's hosted Finland egress (a fully unrestricted region under Polymarket's policy), so trading works out of the box; `setup` reports your status. Override `POLYMARKET_CLOB_HOST` to go direct or run your own egress, optionally reached via `HTTPS_PROXY` / `POLYMARKET_CLOB_PROXY` (a proxy alone doesn't change the Polymarket-facing egress). Complying with Polymarket's terms for your jurisdiction is your responsibility.

> ⚠️ **Back up your signer key** (`~/.blockrun/.session` by default; a `BLOCKRUN_WALLET_KEY` env var or an existing agent `wallet.json` takes precedence — `setup` prints the actual signer address). It is the only key to both the payment wallet and the Polymarket deposit wallet.

---

## Fund your wallet

Run `blockrun_wallet` to see your address. The server pays on **Base** by default.

| Method | Steps |
|--------|-------|
| Coinbase | Send → USDC → Base network → paste address |
| Bridge from Ethereum | [bridge.base.org](https://bridge.base.org) |

$5 covers ~525 market queries, ~500 Exa searches, ~250 image generations, or ~10 Seedance 1.5-pro clips (5s @ 720p+audio, ~$0.46 each).

### Pay on Solana

Two tool calls — no env vars, no file editing, no restart:

```
blockrun_wallet action:"chain" chain:"solana"   # provisions + activates the Solana wallet
blockrun_wallet action:"setup"                  # shows the Solana address + funding QR
```

Then send USDC (SPL) on the **Solana** network — from Coinbase (pick "Solana"), Phantom, Solflare, or Backpack. Switch back with `blockrun_wallet action:"chain" chain:"base"`. The server keeps both wallets; switching just changes which one pays.

**Base-only** — these fall back to Base regardless of active chain: `blockrun_music`, `blockrun_speech`, `blockrun_video`, paid `blockrun_realface`, paid stock `blockrun_price`, and native Anthropic (`claude-*`) passthrough. In Solana mode they return a "switch to Base" message instead of charging. `blockrun_image` pays on either chain.

---

## For agents & LLMs

> **If you are an LLM invoking BlockRun MCP tools, read these first:**

- **CRITICAL: On any payment / balance / 402 error, call `blockrun_wallet` *first*** to check status, then `action:"setup"` for funding. Don't retry the failing tool blindly — the wallet is empty.
- **CRITICAL: `blockrun_polymarket` moves REAL user funds** (pUSD on Polygon), separate from the x402 API budget. Never `buy`/`sell`/`redeem` with `confirm:true` unless the user explicitly approved that exact trade; without `confirm` you get a safe dry-run. Discover markets/token IDs with `blockrun_markets` first.
- **CRITICAL: `blockrun_surf`'s 84-endpoint catalog is in [`skills/surf/SKILL.md`](skills/surf/SKILL.md); `blockrun_markets`' full endpoint list is in its tool description** (worked examples in [`skills/prediction-markets/SKILL.md`](skills/prediction-markets/SKILL.md); live-demo workflow in [`skills/signal-to-trade-demo/SKILL.md`](skills/signal-to-trade-demo/SKILL.md)). Browse those before guessing paths.
- **CRITICAL: `blockrun_music` and `blockrun_video` are payment-on-completion async.** Failures / client timeouts do NOT charge. Don't retry-loop — they may take 60–180s.
- **CRITICAL: Before spawning child agents, allocate per-agent budget:** `blockrun_wallet action:"delegate" agent_id:"X" agent_limit:1.00`, then pass `agent_id:"X"` to every downstream call. The child is auto-blocked at zero.
- **Free tier first for drafts:** `blockrun_chat mode:"free"` (NVIDIA), `blockrun_dex`, `blockrun_price` (crypto/FX/commodity), and `blockrun_models` are $0.

---

## Showcase

Posters generated through `blockrun_image` with `openai/gpt-image-2` — each a single API call routed through BlockRun, paid in USDC on Base.

<p align="center">
  <img src="assets/posters/gpt-5-5-launch.png" width="600" alt="gpt-5.5 — now live on BlockRun. Pay per call. No subscription. No keys.">
</p>

| | | |
|:---:|:---:|:---:|
| <img src="assets/posters/cornell-2026-popular-booth.png" width="260" alt="BlockRun at the Cornell Blockchain Conference 2026, packed booth"> | <img src="assets/posters/cornell-2026.png" width="260" alt="BlockRun at the Cornell Blockchain Conference 2026"> | <img src="skills/image-prompting/example-100t-poster.jpg" width="260" alt="100 Trillion Tokens served — synthwave milestone poster"> |
| **Cornell Blockchain Conference 2026** | **Cornell Blockchain Conference 2026** | **100 Trillion Tokens** milestone |

Prompts and a worked example are in [`skills/image-prompting/SKILL.md`](skills/image-prompting/SKILL.md).

---

## Why not just use the APIs directly?

| | Direct APIs | BlockRun |
|---|---|---|
| Exa | Sign up, $20/mo minimum | $0.01/call, no subscription |
| Polymarket | Undocumented, rate-limited | $0.0095/call, clean JSON — plus you can **trade** |
| Surf (asksurf.ai) | Account + monthly plan | $0.0095/call, no account, 83 endpoints |
| Multiple sources | 3 accounts, 3 API keys, 3 billing pages | **1 wallet** |

One wallet. All sources. No dashboards.

---

## Configuration

<details>
<summary><strong>Environment variables & files</strong></summary>

| Variable / File | Default | Effect |
|---|---|---|
| `~/.blockrun/.session` | auto-created on first run | EVM private key (0x…). File exists → use Base. Also the Polymarket signer (unless `BLOCKRUN_WALLET_KEY` or an agent `wallet.json` takes precedence). |
| `BLOCKRUN_WALLET_KEY` | unset | Env override of the EVM key — takes precedence over `.session` / `wallet.json` as the Base + Polymarket signer. |
| `~/.blockrun/.chain` | unset | Explicit chain preference: `base` or `solana`. |
| `~/.blockrun/.solana-session` | not created | Solana private key. File exists → Solana unless `.chain` says `base`. |
| `SOLANA_WALLET_KEY` | unset | Env override of `.solana-session`. Set → use Solana. |
| `BLOCKRUN_MCP_PROFILE` | `full` | Tool profile (`media` / `trading` / `research` / `chat`). |
| `POLYMARKET_CLOB_HOST` | BlockRun Finland relay | Geoblock egress for order placement — **defaulted for you**. Override to go direct (`https://clob.polymarket.com`) or your own egress. |
| `POLYMARKET_MAX_BET_USD` | `25` | Hard per-order notional cap. |
| `POLYMARKET_MAX_SESSION_USD` | unset | Optional cumulative per-process betting cap. |
| `POLYMARKET_SIG_TYPE` | `3` | `3` = deposit wallet (POLY_1271, gasless); `0` = plain EOA mode. |
| `POLYMARKET_CLOB_PROXY` | unset | HTTPS proxy for Polymarket CLOB traffic only. |
| `POLYMARKET_BOUNDED_APPROVALS` | unset (unlimited) | Bound pUSD exchange allowances to this many dollars. |
| `BLOCKRUN_BUILDER_CODE` | unset | Optional Polymarket builder attribution code carried on orders. |

**Chain selection priority** (`src/utils/wallet.ts`): `.chain` preference → `SOLANA_WALLET_KEY` → `.solana-session` exists → otherwise Base.

The server runs a non-blocking npm registry check at startup and prints an `Update available` notice to stderr when a newer `@blockrun/mcp` exists — re-run the install command to upgrade.

</details>

---

## Troubleshooting

- **`Insufficient balance` / HTTP 402 after retry** → Run `blockrun_wallet action:"setup"`, send USDC on Base (or Solana).
- **`blockrun` doesn't connect / "MCP server failed" / `spawn npx ENOENT`** → Almost always a **PATH issue**: Claude Code can't find `node`/`npx` on its launcher PATH (common with Homebrew / nvm, on CLI *and* desktop). Fix by passing your shell PATH at install:
  ```bash
  claude mcp remove blockrun -s user
  claude mcp add blockrun -s user -e PATH="$PATH" -- npx -y @blockrun/mcp@latest
  ```
  Then restart Claude Code. Or pin absolute paths (`which npx`).
- **`claude mcp list` doesn't show `blockrun`** → Check `node -v` (≥20.19). Clear the npx cache: `rm -rf ~/.npm/_npx`. Re-run the install.
- **`fetch failed` / balance-check timeout** → Base RPC transient outage. The tool falls through 3 public RPCs; retry after 30s. Persistent = local proxy / firewall blocking outbound RPC.
- **`Video`/`Music generation timed out`** → Upstream queue congestion. **No charge** (payment-on-completion). Retry, or pick a faster model.
- **Polymarket: neg-risk ("winner") market buy fails, or `redeem` reverts, though setup shows ready** → Re-run `action:"setup" confirm:true` once (grants the on-chain approvals a pre-upgrade deposit wallet may lack — including the collateral-adapter approvals `redeem` needs). See the [setup guide](docs/polymarket-trading-setup.md).

---

## FAQ

**What is BlockRun MCP?**
An open-source MCP server that gives Claude and other agents <!-- br:mcp.tools -->20<!-- /br:mcp.tools --> tools for real-time data and real actions (trading, media, on-chain), paid per call in USDC. No accounts, no API keys.

**Do I need API keys or accounts?**
No. A wallet is auto-created locally on first run; you fund it with USDC. No signups, no dashboards, no key rotation.

**How much does it cost?**
Pay-per-call — fractions of a cent to a few cents. The free tier (`blockrun_chat mode:"free"`, `blockrun_dex`, crypto `blockrun_price`, `blockrun_models`) is $0. $5 of USDC covers thousands of queries.

**Is it safe / non-custodial?**
Yes. Your private key never leaves your machine (`~/.blockrun/.session` by default, `0600`). x402 payments and Polymarket orders are signed locally — BlockRun forwards signed payloads and cannot move your funds.

**Which clients work?**
Claude Code, Claude Desktop, Cursor, Windsurf, and any MCP-compatible client.

**Can it really place real bets?**
Yes. `blockrun_polymarket` places real, USDC-settled orders on Polymarket's CLOB — confirm-gated and capped. Read the odds with `blockrun_markets`, place with `blockrun_polymarket`.

**Base or Solana?**
Both. Switch instantly with `blockrun_wallet action:"chain"`. A few media/paid tools settle on Base only (noted above).

---

## From the BlockRun ecosystem

BlockRun is agent-native AI infrastructure — one wallet, x402 USDC micropayments, across every surface:

- **⚡ [ClawRouter](https://github.com/BlockRunAI/ClawRouter)** — the agent-native LLM router for OpenClaw. <!-- br:models.chatVisible -->66<!-- /br:models.chatVisible --> models, <1ms local routing, USDC on Base & Solana.
- **🤖 [BRCC](https://blockrun.ai/brcc.md)** — BlockRun for Claude Code: smart routing + x402 payments, purpose-built for Claude Code.
- **🐍 [ClawRouter-Hermes](https://github.com/BlockRunAI/ClawRouter-Hermes)** — Python plugin wiring NousResearch Hermes into the ClawRouter proxy.
- **📚 [Docs](https://blockrun.ai/docs)** · **[Models & pricing](https://blockrun.ai/models)** — full SDKs, APIs, and the model catalogue.

---

## Support & community

| | |
|---|---|
| 💬 Community Telegram | [t.me/blockrunAI](https://t.me/blockrunAI) |
| 🐦 X / Twitter | [@BlockRunAI](https://x.com/BlockRunAI) |
| 📖 Documentation | [blockrun.ai/docs](https://blockrun.ai/docs) |
| 🐛 Issues | [github.com/BlockRunAI/blockrun-mcp/issues](https://github.com/BlockRunAI/blockrun-mcp/issues) |

---

## Contributing

PRs welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, the tool-vs-skill design rule, and how to add a new partner API.

---

<div align="center">

**MIT License** · [blockrun.ai](https://blockrun.ai) — Agent-native AI infrastructure

[Website](https://blockrun.ai) · [npm](https://www.npmjs.com/package/@blockrun/mcp) · [Docs](https://blockrun.ai/docs) · [@BlockRunAI](https://x.com/BlockRunAI)

</div>
