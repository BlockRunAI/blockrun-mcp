---
name: surf
description: Use when the user wants crypto data — token prices, on-chain SQL, prediction-market positions, CEX order books, wallet labels/net-worth, social mindshare, news, or a Surf-1.5 chat answer with citations. 84 endpoints across exchange, on-chain, wallet, social, prediction, news, search, and chat — one API, pay-per-call in USDC via x402. Settles directly to Surf's Base treasury; no Surf account needed.
triggers:
  - "surf"
  - "asksurf"
  - "surf-1.5"
  - "crypto data"
  - "on-chain sql"
  - "clickhouse crypto"
  - "wallet labels"
  - "wallet net worth"
  - "smart followers"
  - "ct mindshare"
  - "social mindshare"
  - "kol search"
  - "fear and greed"
  - "etf flows"
  - "funding rate"
  - "long short ratio"
  - "liquidation chart"
  - "tokenomics unlock"
  - "vc fund portfolio"
  - "defi protocol metrics"
  - "bridge ranking"
  - "yield ranking"
  - "airdrop search"
  - "options skew"
  - "perp snapshot"
  - "gas price"
  - "polymarket data"
  - "kalshi data"
---

# Surf — Crypto Data via BlockRun

Surf (asksurf.ai) aggregates **84 crypto data endpoints** across CEX market data, on-chain SQL (13 chains, 80+ ClickHouse tables), 100M+ labeled wallets, prediction markets (Polymarket + Kalshi side-by-side), social/CT intelligence, news, unified search, and Surf-1.5 chat with citations.

BlockRun is Surf's x402 payment rail — every call settles **directly to Surf's Base treasury**. You hold the wallet, BlockRun holds the Surf key, Surf holds the data. No Surf account, no API key, no monthly minimum.

## How to Call from MCP

One tool, three params. The MCP tool auto-routes method (POST when `body` is set, GET otherwise) and auto-validates required params before settling:

```ts
blockrun_surf({ path: "market/price", params: { symbol: "BTC" } })

blockrun_surf({ path: "onchain/sql", body: {
  sql: "SELECT token_address, count() FROM ethereum.dex_trades WHERE block_time > now() - INTERVAL 1 DAY GROUP BY 1 ORDER BY 2 DESC LIMIT 10"
}})

blockrun_surf({ path: "chat/completions", body: {
  model: "surf/surf-1.5",
  messages: [{ role: "user", content: "What's the Polymarket consensus for the 2028 US election?" }],
}})
```

## Pricing — two tiers, flat

| Tier | Price | Used by |
|------|-------|---------|
| Standard | $0.0075 | every read: prices, rankings, news, order books, candles, search, wallet detail, social, prediction markets (80 endpoints) |
| Premium | $0.0200 | raw on-chain SQL, schema introspection, structured queries (3 endpoints) |

Verified against the gateway's own 402 responses, which are free to request — send any call with no payment header and it replies with the exact price. Standard is genuinely flat: `market/price`, `wallet/labels/batch`, `social/mindshare`, `news/feed`, `exchange/klines` and `search/web` all quote $0.0075.

Wrong / missing required params return HTTP 400 **without charging** — pre-validation runs before settlement.

## Do NOT use Surf for prediction markets

Surf carries 17 `prediction-market/*` endpoints (Polymarket + Kalshi). **Use `blockrun_markets` (Predexon) instead — same data, same price, and far deeper.**

Predexon used to be 7.5× cheaper; since 2026-07-15 both bill the same flat rate, so the choice is now purely about coverage — and Predexon still wins on coverage by a wide margin.

| | Predexon (`blockrun_markets`) | Surf |
|---|---|---|
| Polymarket / Kalshi markets | $0.0075 | $0.0075 (same) |
| Wallet clustering, smart money, leaderboards | ✅ | ❌ none |
| Limitless, Opinion, Predict.Fun, dFlow, sports, UMA | ✅ | ❌ Polymarket + Kalshi only |

The only Surf prediction-market endpoint with no Predexon equivalent is `prediction-market/category-metrics`. Everything else is a strictly worse buy. See [`skills/prediction-markets/SKILL.md`](../prediction-markets/SKILL.md).

**Reach for Surf when Predexon cannot answer it:** on-chain SQL, 100M+ wallet labels across 13 chains, 16 CEXs, social/CT intelligence, news, tokenomics/unlocks, liquidations, ETF flows, VC portfolios. Predexon has none of those.

## Quick Decision Table — "User asks about X"

| User wants… | Method | Path | Required | Tier |
|---|---|---|---|---|
| BTC/ETH price | GET | `market/price` | `symbol` | 1 |
| ETF flow history | GET | `market/etf` | `symbol` | 1 |
| Fear & Greed index | GET | `market/fear-greed` | – | 1 |
| Top 100 tokens by market cap | GET | `market/ranking` | – | 1 |
| Options skew / IV / volume | GET | `market/options` | `symbol` | 1 |
| CEX ticker for a pair | GET | `exchange/price` | `pair` | 1 |
| Perp snapshot (funding + OI) | GET | `exchange/perp` | `pair` | 1 |
| Order book depth | GET | `exchange/depth` | `pair` | 2 |
| OHLCV candles | GET | `exchange/klines` | `pair` | 2 |
| Funding rate history | GET | `exchange/funding-history` | `pair` | 2 |
| Long/short ratio | GET | `exchange/long-short-ratio` | `pair` | 2 |
| Bridge protocols by volume | GET | `onchain/bridge/ranking` | – | 1 |
| Yield pool ranking | GET | `onchain/yield/ranking` | – | 1 |
| Current gas price (per chain) | GET | `onchain/gas-price` | `chain` | 1 |
| Transaction details | GET | `onchain/tx` | `hash`, `chain` | 1 |
| **Raw on-chain SQL** | POST | `onchain/sql` | body: `sql` | 3 |
| **Structured on-chain query** | POST | `onchain/query` | body: typed predicates | 3 |
| Inspect ClickHouse schema | GET | `onchain/schema` | – | 3 |
| Polymarket markets ranking | GET | `prediction-market/polymarket/ranking` | – | 1 |
| Polymarket price history | GET | `prediction-market/polymarket/prices` | `condition_id` | 1 |
| Polymarket positions for wallet | GET | `prediction-market/polymarket/positions` | `address` | 2 |
| Kalshi markets ranking | GET | `prediction-market/kalshi/ranking` | – | 1 |
| Kalshi market detail | GET | `prediction-market/kalshi/markets` | `market_ticker` | 1 |
| **Search Polymarket / Kalshi** | GET | `search/polymarket` / `search/kalshi` | – | 2 |
| Wallet profile (cross-chain) | GET | `wallet/detail` | `address` | 2 |
| Wallet net-worth time series | GET | `wallet/net-worth` | `address` | 2 |
| Wallet DeFi positions | GET | `wallet/protocols` | `address` | 2 |
| **Batch wallet labels (CEX/Whale/MEV…)** | GET | `wallet/labels/batch` | `addresses` | 2 |
| Token tokenomics + unlocks | GET | `token/tokenomics` | – | 1 |
| Token holders top N | GET | `token/holders` | `address`, `chain` | 2 |
| Token transfers | GET | `token/transfers` | `address`, `chain` | 2 |
| Token DEX trades | GET | `token/dex-trades` | `address` | 2 |
| Social mindshare time series | GET | `social/mindshare` | `q`, `interval` | 2 |
| Smart-follower history | GET | `social/smart-followers/history` | – | 2 |
| Twitter user profile | GET | `social/user` | `handle` | 1 |
| Twitter user posts | GET | `social/user/posts` | `handle` | 1 |
| Tweet replies | GET | `social/tweet/replies` | `tweet_id` | 1 |
| **Web search (crypto-scoped)** | GET | `search/web` | `q` | 2 |
| News article search | GET | `search/news` | `q` | 2 |
| KOL / CT people search | GET | `search/social/people` | `q` | 2 |
| Tweet full-text search | GET | `search/social/posts` | `q` | 2 |
| Project / token search | GET | `search/project` | `q` | 2 |
| Wallet search (by ENS, label) | GET | `search/wallet` | `q` | 2 |
| VC fund portfolio | GET | `fund/portfolio` | – | 1 |
| VC fund ranking | GET | `fund/ranking` | `metric` | 1 |
| DeFi protocol ranking | GET | `project/defi/ranking` | `metric` | 1 |
| Project full profile | GET | `project/detail` | – | 1 |
| Clean a webpage to markdown | GET | `web/fetch` | `url` | 2 |
| **Surf-1.5 chat with citations** | POST | `chat/completions` | body: `model`, `messages` | 3 |
| News feed | GET | `news/feed` | – | 1 |
| Single news article | GET | `news/detail` | `id` | 1 |

## Worked Examples

### 1. "What's BTC trading at?"

```ts
blockrun_surf({ path: "market/price", params: { symbol: "BTC" } })
```
**Cost: $0.001.** Returns price history; latest point = current price.

### 2. "Top 10 tokens by DEX volume on Ethereum in the last 24h"

```ts
blockrun_surf({
  path: "onchain/sql",
  body: {
    sql: `
      SELECT token_address, sum(amount_usd) AS volume_usd
      FROM ethereum.dex_trades
      WHERE block_time > now() - INTERVAL 1 DAY
      GROUP BY token_address
      ORDER BY volume_usd DESC
      LIMIT 10
    `
  }
})
```
**Cost: $0.02.** Raw ClickHouse — same query language Surf's own UI uses.

### 3. "Is this whale wallet labeled? What does it hold?"

```ts
// Step 1 — labels (CEX / Whale / Bridge / MEV / Bot / Fund)
blockrun_surf({ path: "wallet/labels/batch", params: { addresses: "0xabc...,0xdef..." } })

// Step 2 — cross-chain holdings + DeFi positions
blockrun_surf({ path: "wallet/detail", params: { address: "0xabc..." } })
blockrun_surf({ path: "wallet/protocols", params: { address: "0xabc..." } })

// Step 3 — net-worth time series
blockrun_surf({ path: "wallet/net-worth", params: { address: "0xabc..." } })
```
**Cost: 4 × $0.005 = $0.02.** Replaces a Nansen subscription for one-off lookups.

### 4. "What's the market saying about the 2028 election?"

```ts
// Compare Polymarket + Kalshi side by side
blockrun_surf({ path: "search/polymarket", params: { q: "2028 US president" } })
blockrun_surf({ path: "search/kalshi",     params: { q: "2028 US president" } })

// Then pull the order book on the leading market
blockrun_surf({ path: "prediction-market/polymarket/prices",
                params: { condition_id: "0x..." } })
```

### 5. "Surf-1.5 chat with grounded citations"

```ts
blockrun_surf({
  path: "chat/completions",
  body: {
    model: "surf/surf-1.5",
    messages: [
      { role: "user", content: "Summarize ETH's on-chain activity this week. Cite sources." }
    ],
    citation: ["source", "chart"]
  }
})
```
**Cost: $0.02 flat (per-token billing in Phase 2).** Returns OpenAI-compatible response + citations.

### 6. "Where's mindshare moving for L1s?"

```ts
blockrun_surf({ path: "social/mindshare", params: { q: "solana", interval: "1d" } })
blockrun_surf({ path: "social/mindshare", params: { q: "monad",  interval: "1d" } })
blockrun_surf({ path: "social/ranking" })
```

### 7. "ETF flows + funding rate + long/short — give me the macro picture"

```ts
blockrun_surf({ path: "market/etf",                params: { symbol: "BTC" } })       // T1
blockrun_surf({ path: "market/fear-greed" })                                          // T1
blockrun_surf({ path: "exchange/funding-history",  params: { pair: "BTC-USDT" } })   // T2
blockrun_surf({ path: "exchange/long-short-ratio", params: { pair: "BTC-USDT" } })   // T2
```
**Cost: 2 × $0.001 + 2 × $0.005 = $0.012.**

## Method Routing — When to Use `body`

Pass `body` (POST) only for these three endpoints:

- `onchain/query` — structured, typed predicates against ClickHouse
- `onchain/sql` — raw SQL string in `{ sql: "..." }`
- `chat/completions` — OpenAI-compatible chat completion

Everything else is GET with `params`.

## Python SDK (for non-MCP use)

```python
from blockrun_llm import setup_agent_wallet

client = setup_agent_wallet()

# GET — same as blockrun_surf({ path, params })
price = client._get_with_payment_raw("/v1/surf/market/price", {"symbol": "BTC"})

# POST — same as blockrun_surf({ path, body })
result = client._request_with_payment_raw("/v1/surf/onchain/sql", {
    "sql": "SELECT count() FROM ethereum.transactions WHERE block_time > now() - INTERVAL 1 HOUR"
})
```

## Full Endpoint Catalog (84 endpoints, 13 categories)

### Exchange (CEX) — 7
`exchange/markets` · `exchange/price` · `exchange/perp` · `exchange/depth` · `exchange/klines` · `exchange/funding-history` · `exchange/long-short-ratio`

### Fund (VC intelligence) — 3
`fund/detail` · `fund/portfolio` · `fund/ranking`

### Market — 11
`market/ranking` · `market/fear-greed` · `market/futures` · `market/price` · `market/etf` · `market/options` · `market/liquidation/exchange-list` · `market/liquidation/order` · `market/liquidation/chart` · `market/onchain-indicator` · `market/price-indicator`

### News — 2
`news/feed` · `news/detail`

### On-chain — 7
`onchain/bridge/ranking` · `onchain/yield/ranking` · `onchain/gas-price` · `onchain/tx` · `onchain/schema` · `onchain/query` (POST) · `onchain/sql` (POST)

### Prediction Markets — 17
**Polymarket**: `prediction-market/polymarket/ranking` · `.../trades` · `.../markets` · `.../events` · `.../prices` · `.../volumes` · `.../open-interest` · `.../positions` · `.../activity` · `prediction-market/category-metrics`
**Kalshi**: `prediction-market/kalshi/ranking` · `.../markets` · `.../events` · `.../prices` · `.../trades` · `.../volumes` · `.../open-interest`

### Project + DeFi — 3
`project/detail` · `project/defi/metrics` · `project/defi/ranking`

### Search — 11
`search/airdrop` · `search/events` · `search/kalshi` · `search/polymarket` · `search/web` · `search/project` · `search/news` · `search/wallet` · `search/fund` · `search/social/people` · `search/social/posts`

### Social — 11
`social/detail` · `social/ranking` · `social/smart-followers/history` · `social/mindshare` · `social/tweets` · `social/tweet/replies` · `social/user` · `social/user/followers` · `social/user/following` · `social/user/posts` · `social/user/replies`

### Token — 4
`token/tokenomics` · `token/dex-trades` · `token/holders` · `token/transfers`

### Wallet — 6
`wallet/detail` · `wallet/history` · `wallet/net-worth` · `wallet/transfers` · `wallet/protocols` · `wallet/labels/batch`

### Web — 1
`web/fetch`

### Chat — 1
`chat/completions` (POST) — Surf-1.5 with `citation: ["source","chart"]` support

## Gotchas

- **Required params:** 56 of 84 endpoints require at least one param. The 402 response and the in-tool route surface which fields are missing. Missing params → 400 + no charge.
- **Solana wallet works too**: `blockrun_surf` routes through whichever chain the BlockRun wallet is on (Base or Solana). Surf settlement always lands in Surf's Base treasury.
- **`onchain/sql` is powerful but unrestricted**: there's no row limit on the server side. Add `LIMIT` to your query or you'll pay for a megabyte of JSON.
- **`chat/completions` is flat $0.02 in v1** — per-token billing rolls out in Phase 2. For high-volume chat, run cost estimates assuming the flat rate.
- **The chat endpoint uses a different upstream base** (`api.asksurf.ai/v1` instead of `/gateway/v1`). The BlockRun proxy handles this transparently — you just call `chat/completions`.
- **`X-Payment-Receipt` header** lands on the response with the settlement tx hash — keep it for accounting.

## Reference

- Surf marketplace page: https://blockrun.ai/marketplace/surf
- Surf upstream docs: https://docs.asksurf.ai
- Surf publisher: https://asksurf.ai
- BlockRun proxy source: `src/lib/surf.ts` in the BlockRun web repo
