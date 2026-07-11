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

### Pattern 1: Regular Price Checks ($0.001 each)

The cheapest BlockRun calls. Use them liberally.

```python
# Single price
blockrun_price(action="price", category="crypto", symbol="BTC-USD")

# Batch of prices
blockrun_price(action="price", category="crypto", symbol="ETH-USD")
blockrun_price(action="price", category="crypto", symbol="SOL-USD")

# Free — discover available symbols
blockrun_price(action="list", category="crypto", query="sol")
```

**Cost:** $0 per list call, $0.001 per price call. **Use `list` for free discovery.**

### Pattern 2: Token Research Pipeline ($0.002–0.012)

Combine free + cheap tools for a complete token picture.

```python
# 1. Free — DEX liquidity + volume (free endpoint)
blockrun_dex({ query: "SOL" })

# 2. $0.001 — CEX price
blockrun_price(action="price", category="crypto", symbol="SOL-USD")

# 3. $0.001 — Protocol TVL
blockrun_defi({ path: "protocols" })
blockrun_defi({ path: "protocol/jupiter" })

# 4. $0.001 — Chain TVL
blockrun_defi({ path: "chains" })
```

**Total: ~$0.003–0.004 per full token analysis.** Replace CoinGecko/CMC tabs entirely.

### Pattern 3: Research + Synthesis ($0.010–0.035)

Use Exa (neural search) + BlockRun Chat (second opinion) for thorough research.

```python
# 1. $0.01 — Neural web search with Exa
blockrun_exa({ path: "search", body: {
  query: "latest AI agent infrastructure developments 2026",
  numResults: 10,
  category: "research paper"
}})

# 2. $0.001 — Get second opinion from GLM-5 (excellent for technical details)
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
# 1. TVL & protocol health ($0.001)
blockrun_defi({ path: "protocol/aave-v3" })

# 2. Yield pools ($0.001)
blockrun_defi({ path: "yields" })

# 3. Token price ($0.001)
blockrun_price(action="price", category="crypto", symbol="AAVE-USD")

# 4. DEX activity (free)
blockrun_dex({ token: "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9" })
```

### Portfolio Health Check

```python
# 1. Current holdings (free — local data or blockrun_rpc)
blockrun_rpc({ network: "base", method: "eth_getBalance", params: ["0xabc...", "latest"] })

# 2. Token prices ($0.001 each)
blockrun_price(action="price", category="crypto", symbol="ETH-USD")
blockrun_price(action="price", category="crypto", symbol="USDC-USD")

# 3. Prediction market positions ($0.001)
blockrun_markets({ path: "polymarket/positions" })
```

### Content Generation Pipeline

```python
# 1. Research ($0.01)
blockrun_exa({ path: "search", body: { query: "agentic commerce trends", numResults: 5 }})

# 2. Image generation for post ($0.015 cheapest to $0.12 quality)
blockrun_image({ prompt: "AI agent futuristic dashboard with neon grids" })

# 3. Voiceover for video ($0.05/1k chars)
blockrun_speech({ input: "Your narration text here...", voice: "sarah" })

# 4. Music track ($0.1575)
blockrun_music({ prompt: "upbeat synthwave background" })

# 5. Short video clip ($0.40)
blockrun_video({ prompt: "animated data visualization", duration_seconds: 8 })
```

---

## Cost Optimization Strategies

### Tier Mapping

| Call Type | Price | Frequency |
|-----------|-------|-----------|
| `blockrun_price` (list) | FREE | daily discovery |
| `blockrun_dex` | FREE | unlimited |
| `blockrun_rpc` | $0.002 | on-chain reads |
| `blockrun_wallet` (status/report) | FREE | before every session |
| `blockrun_price` (quote) | $0.001 | per-token lookup |
| `blockrun_defi` | $0.005 | protocol/chain analysis |
| `blockrun_chat` (free mode) | $0 | NVIDIA-backed chat |
| `blockrun_chat` (glm mode) | $0.001 | Zhipu GLM-5 coding |
| `blockrun_exa` (search) | $0.01 | deep research |
| `blockrun_surf` (T1) | $0.001 | crypto data |
| `blockrun_surf` (T2) | $0.005 | wallets/candles/search |
| `blockrun_surf` (T3) | $0.02 | on-chain SQL |
| `blockrun_speech` | $0.05/1k chars | TTS |
| `blockrun_image` | $0.015–0.12 | image generation |
| `blockrun_music` | $0.1575 | music tracks |
| `blockrun_video` | $0.40+ | short video clips |
| `blockrun_markets` (T1) | $0.001 | prediction market data |
| `blockrun_markets` (T2) | $0.005 | wallet analytics |
| `blockrun_modal` | $0.001+ | remote sandbox execution |
| `blockrun_phone` | $0.01–5.00 | phone lookups |

### Daily Budget Formula (GenTech's Setup)

```yaml
# ~$0.30/day typical
Daily budget:
  Free tools:     unlimited (dex, list, wallet status)
  Tier-1 data:   ~$0.05 (prices, defi, surf T1)
  Tier-2 data:   ~$0.05 (surf T2, markets T1)
  AI calls:      ~$0.10 (chat free mode, occasional glm)
  Media:         ~$0.10 (occasional image/speech)
  Total:         ~$0.30/day
```

Set a $5/week budget cap and never hit it with typical usage.

---

## Error Handling Patterns

### 402 Payment Required (Expected — Not an Error)

```python
# BlockRun auto-handles this internally.
# If a paid call returns 402, the SDK signs the challenge
# and retries. No action needed.
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

- **Token prices:** Cache for 30–60 seconds (change faster but $0.001 each is negligible)
- **Protocol TVL:** Cache for 1 hour (updates hourly)
- **Wallet labels:** Cache for 24 hours (rarely change)
- **On-chain SQL results:** Cache for 1 hour (most queries return the same answer)

GenTech's approach: Don't bother caching prices ($0.001 is too cheap to cache). Cache TVL and wallet labels aggressively.

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

- BlockRun MCP: https://github.com/blockrunai/blockrun-mcp
- BlockRun Docs: https://blockrun.ai/docs
- Models & Pricing: https://blockrun.ai/models
- Community: https://t.me/blockrunAI
- GenTech Labs: https://github.com/ProtoJay4789/genTech-agent-kit
