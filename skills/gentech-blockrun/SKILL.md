---
name: gentech-blockrun
description: "GenTech Labs' integration patterns for BlockRun MCP from Hermes Agent. Covers daily usage patterns, cost-optimized workflows, multi-tool pipelines, and reliable error handling for BlockRun's full toolset."
triggers:
  - "blockrun"
  - "blockrun chat"
  - "blockrun search"
  - "blockrun price"
  - "blockrun defi"
  - "blockrun video"
  - "blockrun music"
  - "blockrun speech"
  - "blockrun wallet"
  - "blockrun rpc"
  - "blockrun surf"
  - "blockrun markets"
  - "blockrun exa"
  - "x402 payment"
  - "pay per call"
  - "micropayment"
  - "BlockRun MCP"
  - "cost optimization blockrun"
  - "multi-tool pipeline"
  - "agent wallet blockrun"
  - "gen tech blockrun"
---

# GenTech Labs — BlockRun Integration Patterns

Real-world patterns from running BlockRun MCP in production across 32 cron jobs and daily agent operations.

---

## Getting Started

### Initial Wallet Setup

```bash
# Set up BlockRun wallet (one-time)
blockrun_wallet(action="setup")
# → Follow the QR to fund the wallet with USDC
```

### Budget Controls

```python
# Set a global budget cap so spending never surprises you
blockrun_wallet(action="budget", budget_action="set", budget_amount=10.0)

# Spawn child agents with delegate budgets
blockrun_wallet(action="delegate", agent_id="researcher", agent_limit=2.0)
blockrun_wallet(action="delegate", agent_id="data-poller", agent_limit=0.50)
```

### Check Balance

```python
blockrun_wallet(action="status")
# → Two wallets: Base + Solana. Active chain shown. Check before expensive runs.
```

---

## Daily Usage Patterns

### Pattern 1: Regular Price Checks (FREE)

Crypto, FX and commodity quotes cost **nothing** — `blockrun_price` is free for those
categories (only `stocks`/`usstock` is paid, at $0.0020). Use them liberally, and do
not pay $0.0085 to `blockrun_surf` for a quote you can get for $0.

```python
# Single price
blockrun_price(action="price", category="crypto", symbol="BTC-USD")

# Batch of prices
blockrun_price(action="price", category="crypto", symbol="ETH-USD")
blockrun_price(action="price", category="crypto", symbol="SOL-USD")

# Free — discover available symbols
blockrun_price(action="list", category="crypto", query="sol")
```

**Cost:** $0 — crypto/FX/commodity price *and* list calls are both free. Only `category:"stocks"` is paid ($0.0020).

### Pattern 2: Token Research Pipeline (~$0.018)

Start with the free tools, then pay only for what they cannot answer.

```python
# 1. Free — DEX liquidity + volume (free endpoint)
blockrun_dex({ query: "SOL" })

# 2. FREE — CEX price (crypto category is free)
blockrun_price(action="price", category="crypto", symbol="SOL-USD")

# 3. $0.0060 each — Protocol TVL
blockrun_defi({ path: "protocols" })
blockrun_defi({ path: "protocol/jupiter" })

# 4. $0.0060 — Chain TVL
blockrun_defi({ path: "chains" })
```

**Total: ~$0.018 per full token analysis** (2 free calls + 3 x $0.0060 DefiLlama). Replace CoinGecko/CMC tabs entirely.

### Pattern 3: Research + Synthesis (~$0.011 + chat)

Use Exa (neural search) + BlockRun Chat (second opinion) for thorough research.

```python
# 1. $0.0110 — Neural web search with Exa
blockrun_exa({ path: "search", body: {
  query: "latest AI agent infrastructure developments 2026",
  numResults: 10,
  category: "research paper"
}})

# 2. per-token — Get second opinion from GLM-5 (excellent for technical details)
blockrun_chat({ mode: "glm", message: "Summarize the key trends..." })
```

**Cost-conscious tip:** Use `mode: "free"` on `blockrun_chat` for zero-cost generation (NVIDIA models).

### Pattern 4: Agent-to-Agent Billing

Use `blockrun_wallet` + `agent_id` for multi-agent cost tracking.

```python
# Allocate budget per agent group
blockrun_wallet(action="delegate", agent_id="research", agent_limit=2.0)
blockrun_wallet(action="delegate", agent_id="content", agent_limit=1.0)

# Pass agent_id on every call
blockrun_surf({ path: "market/price", params: { symbol: "BTC" }, agent_id: "research" })
blockrun_search({ body: { query: "latest news", sources: ["web"] }, agent_id: "research" })

# Audit at end of day
blockrun_wallet(action="report")
```

---

## Multi-Tool Pipelines

### DeFi Intelligence Pipeline

```python
# 1. TVL & protocol health ($0.0060)
blockrun_defi({ path: "protocol/aave-v3" })

# 2. Yield pools ($0.0060)
blockrun_defi({ path: "yields" })

# 3. Token price (FREE — crypto category)
blockrun_price(action="price", category="crypto", symbol="AAVE-USD")

# 4. DEX activity (free)
blockrun_dex({ token: "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9" })
```

### Portfolio Health Check

```python
# 1. Current holdings (free — local data or blockrun_rpc)
blockrun_rpc({ network: "base", method: "eth_getBalance", params: ["0xabc...", "latest"] })

# 2. Token prices (FREE — crypto category)
blockrun_price(action="price", category="crypto", symbol="ETH-USD")
blockrun_price(action="price", category="crypto", symbol="USDC-USD")

# 3. Prediction market positions ($0.0085)
blockrun_markets({ path: "polymarket/positions" })
```

### Content Generation Pipeline

```python
# 1. Research ($0.0110)
blockrun_exa({ path: "search", body: { query: "agentic commerce trends", numResults: 5 }})

# 2. Image generation for post ($0.01675 cheapest to $0.106 quality)
blockrun_image({ prompt: "AI agent futuristic dashboard with neon grids" })

# 3. Voiceover for video ($0.0535/1k chars)
blockrun_speech({ input: "Your narration text here...", voice: "sarah" })

# 4. Music track ($0.1585)
blockrun_music({ prompt: "upbeat synthwave background" })

# 5. Short video clip ($0.421)
blockrun_video({ prompt: "animated data visualization", duration_seconds: 8 })
```

---

## Cost Optimization Strategies

### Tier Mapping

| Call Type | Price | Frequency |
|-----------|-------|-----------|
| `blockrun_price` (list) | FREE | daily discovery |
| `blockrun_dex` | FREE | unlimited |
| `blockrun_rpc` | $0.0030 | on-chain reads (batch: $0.002/element + $0.001) |
| `blockrun_wallet` (status/report) | FREE | before every session |
| `blockrun_price` (quote) | **FREE** | crypto/FX/commodity; stocks $0.0020 |
| `blockrun_defi` | $0.0060 | protocol/chain analysis ($0.0020 for prices/*) |
| `blockrun_chat` (free mode) | $0 | NVIDIA-backed chat |
| `blockrun_chat` (glm mode) | per-token | Zhipu GLM-5 coding — billed on tokens used, not a flat rate |
| `blockrun_exa` (search) | $0.0110 | deep research (`contents`: $0.002/URL + $0.001) |
| `blockrun_surf` | $0.0085 | crypto data, wallets/candles/search, on-chain SQL (flat) |
| `blockrun_speech` | $0.0535/1k chars | TTS |
| `blockrun_image` | $0.01675–0.106 | image generation |
| `blockrun_music` | $0.1585 | music tracks |
| `blockrun_video` | $0.421+ | short video clips (per-second × duration) |
| `blockrun_markets` | $0.0085 | prediction market data, wallet analytics (flat) |
| `blockrun_modal` | $0.0020–$192 | remote sandbox execution — `timeout` drives the price, see the modal skill |
| `blockrun_phone` | $0.0110–$5.001 | lookups; number buy/renew is $5.001 |

### Daily Budget Formula (GenTech's Setup)

```yaml
# ~$0.30/day typical
Daily budget:
  Free tools:     unlimited (price quotes, dex, list, wallet status)
  Crypto data:   ~$0.10 (surf + markets, flat $0.0085 each; defi $0.0060)
  AI calls:      ~$0.10 (chat free mode, occasional glm)
  Media:         ~$0.10 (occasional image/speech)
  Total:         ~$0.30/day
```

Set a $5/week budget cap and never hit it with typical usage.

---

## Error Handling Patterns

### 402 Payment Required

```python
# When the wallet is FUNDED, x402 handles this automatically: the SDK
# signs the payment challenge and retries — no action needed.
#
# When the wallet is EMPTY, the 402 / insufficient-balance surfaces to you.
# Check status and fund FIRST — don't blindly retry the failing tool:
blockrun_wallet(action="status")   # then action="setup" / "deposit"
```

### Insufficient Balance

```python
# Before a batch of expensive calls:
balance = blockrun_wallet(action="status")
if float(balance["usdcBalance"]) < 0.50:
    blockrun_wallet(action="deposit")  # → opens Coinbase Onramp link
```

### Rate Limiting / Timeouts

```python
# For async operations (video, music):
# They auto-poll until complete. If timeout, no charge.
# Retry with same parameters.
```

---

## Caching Strategy

BlockRun calls are cheap but not free. Cache results that don't change minute-to-minute:

- **Token prices:** No need to cache aggressively — crypto/FX/commodity quotes via `blockrun_price` are FREE.
- **Protocol TVL:** Cache for 1 hour (updates hourly)
- **Wallet labels:** Cache for 24 hours (rarely change)
- **On-chain SQL results:** Cache for 1 hour (most queries return the same answer)

GenTech's approach: Don't bother caching prices (crypto/FX/commodity quotes are FREE). Cache TVL and wallet labels aggressively.

---

## Switching Chains

```python
# Default is Base. Switch to Solana for Solana-native tools:
blockrun_wallet(action="chain", chain="solana")

# Switch back:
blockrun_wallet(action="chain", chain="base")

# Check which is active:
blockrun_wallet(action="chain")
```

**Note:** Base is required for music, speech, video, and realface. Solana works for price, wallet, dex, rpc, surf, etc.

---

## Reference

- BlockRun MCP: https://github.com/BlockRunAI/blockrun-mcp
- BlockRun Docs: https://blockrun.ai/docs
- Models & Pricing: https://blockrun.ai/models
- Community: https://t.me/blockrunAI

_Contributed by GenTech Labs, from real production usage of BlockRun MCP._
