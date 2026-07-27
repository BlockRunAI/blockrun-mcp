---
name: crypto-data
description: Use for any crypto data question — token/coin prices, FX, commodities, stocks, OHLC history, DEX pairs and liquidity, DeFi TVL, yield/APY pools, on-chain SQL, wallet labels and net worth, social mindshare, news, or raw JSON-RPC against a chain. Routes across five tools that overlap heavily, so it also says which one to use and which are FREE — blockrun_price (crypto/FX/commodities free, Pyth), blockrun_dex (free, DexScreener), blockrun_defi (DefiLlama TVL + yields), blockrun_surf (83 endpoints — on-chain SQL, 100M+ wallet labels, social), blockrun_rpc (40 chains). No API keys, pay-per-call in USDC via x402.
triggers:
  - "crypto price"
  - "token price"
  - "coin price"
  - "what is btc worth"
  - "eth price"
  - "price history"
  - "ohlc"
  - "candles"
  - "stock price"
  - "forex"
  - "fx rate"
  - "commodity price"
  - "gold price"
  - "dex"
  - "dexscreener"
  - "liquidity pool"
  - "token pair"
  - "trading volume"
  - "defi"
  - "defillama"
  - "tvl"
  - "total value locked"
  - "yield"
  - "apy"
  - "yield farming"
  - "protocol tvl"
  - "chain tvl"
  - "on-chain sql"
  - "wallet labels"
  - "wallet net worth"
  - "whale wallet"
  - "token holders"
  - "token unlock"
  - "tokenomics"
  - "funding rate"
  - "liquidations"
  - "etf flows"
  - "fear and greed"
  - "social mindshare"
  - "crypto news"
  - "json-rpc"
  - "eth_call"
  - "block number"
---

# Crypto Data

Five tools cover crypto data and they overlap. **Pick by cost first** — two of them are free, and paying for a quote you could get for nothing is the most common mistake here.

## Route by cost — check this before calling anything

| Question | Tool | Cost |
|---|---|---|
| **What's BTC/ETH/any coin worth right now?** | `blockrun_price` action:"price" category:"crypto" | **FREE** |
| **Crypto OHLC history** | `blockrun_price` action:"history" category:"crypto" | **FREE** |
| **FX rate / commodity (gold, oil)** | `blockrun_price` category:"fx" or `"commodity"` | **FREE** |
| **Which symbols exist?** | `blockrun_price` action:"list" | **FREE** |
| **DEX pair, liquidity, volume, contract** | `blockrun_dex` | **FREE** |
| Stock quote / history (12 markets) | `blockrun_price` category:"stocks" | $0.0030 |
| Token price by contract address | `blockrun_defi` path:"prices/{coins}" | $0.0030 |
| Raw JSON-RPC on <!-- br:chains.rpc -->40<!-- /br:chains.rpc --> chains | `blockrun_rpc` | $0.0040 |
| Protocol TVL, chain TVL, yields/APY | `blockrun_defi` | $0.0070 |
| **Everything below** (on-chain SQL, wallet labels, social, news, unlocks, liquidations, ETF flows) | `blockrun_surf` | $0.0095 |
| Raw SQL over 80+ ClickHouse tables | `blockrun_surf` path:"onchain/sql" | $0.0095 |

Every price below is what x402 actually **charges** (the base plus the gateway's $0.002 flat fee), verified against live `payment-required` headers — not the base you may see in a 402 body.

**The rule:** a plain crypto price or a DEX pair is free. Only reach for `blockrun_surf` when you need something the free tools genuinely do not have — labels, SQL, social, news, unlocks.

**Prediction markets are never a Surf question.** Surf carries `prediction-market/*` endpoints, but Predexon (`blockrun_markets`) serves the same Polymarket/Kalshi data at the **same $0.0095** — and adds wallet clustering, smart money, sports, UMA, and five more venues that Surf does not have at all. Price is no longer the argument (it was 7.5× cheaper before 2026-07-15); coverage is, and it is decisive. Route odds, positions and market history to [`skills/prediction-markets/SKILL.md`](../prediction-markets/SKILL.md).

## blockrun_price — quotes & history (Pyth-backed)

Free for crypto, FX and commodities. $0.0030 only for stocks.

```ts
blockrun_price({ action: "price",   category: "crypto",    symbol: "BTC-USD" })            // FREE
blockrun_price({ action: "history", category: "crypto",    symbol: "ETH-USD",
                 resolution: "1h", from: 1750000000, to: 1750086400 })                     // FREE
blockrun_price({ action: "price",   category: "fx",        symbol: "EUR-USD" })            // FREE
blockrun_price({ action: "price",   category: "commodity", symbol: "XAU-USD" })            // FREE — gold
blockrun_price({ action: "list",    category: "crypto" })                                  // FREE — discovery
blockrun_price({ action: "price",   category: "stocks",    symbol: "AAPL", market: "us" }) // $0.0030
```

Stock markets: `us`, `hk`, `jp`, `kr`, `gb`, `de`, `fr`, `nl`, `ie`, `lu`, `cn`, `ca` — `market` is required when `category:"stocks"`.

## blockrun_dex — DEX pairs & liquidity (DexScreener)

Free, no payment. Use it for anything pair- or contract-shaped.

```ts
blockrun_dex({ query: "SOL" })                      // search pairs
blockrun_dex({ symbol: "PEPE" })                    // search by symbol
blockrun_dex({ token: "So11111111111111111111111111111111111111112" })  // one token
blockrun_dex({ query: "WETH", chain: "base" })      // scope to a chain
```

## blockrun_defi — TVL & yields (DefiLlama)

Path-based, GET only.

| path | cost | returns |
|---|---|---|
| `protocols` | $0.0070 | every DeFi protocol ranked by TVL |
| `protocol/{slug}` | $0.0070 | one protocol's TVL history + chain breakdown |
| `chains` | $0.0070 | TVL by chain |
| `yields` | $0.0070 | yield pools with APY + TVL (large — filter client-side) |
| `prices/{coins}` | $0.0030 | token prices by contract, e.g. `base:0x8335…,coingecko:ethereum` |

```ts
blockrun_defi({ path: "protocol/aave-v3" })
blockrun_defi({ path: "chains" })
blockrun_defi({ path: "yields" })                   // big payload — filter after
blockrun_defi({ path: "prices/coingecko:ethereum" })
```

## blockrun_surf — the things nothing else has

83 endpoints. Reach here when the free tools cannot answer it: **on-chain SQL, 100M+ labeled wallets across 13 chains, social/CT intelligence, news, tokenomics, liquidations, ETF flows, VC portfolios.** Full catalog and recipes: [`skills/surf/SKILL.md`](../surf/SKILL.md).

```ts
blockrun_surf({ path: "wallet/labels/batch", params: { addresses: "0xabc,0xdef" } })  // CEX/Whale/MEV/Bot
blockrun_surf({ path: "wallet/net-worth",    params: { address: "0xabc" } })
blockrun_surf({ path: "token/tokenomics",    params: { symbol: "ARB" } })             // unlocks + vesting
blockrun_surf({ path: "market/etf",          params: { symbol: "BTC" } })             // ETF flows
blockrun_surf({ path: "social/mindshare",    params: { project: "base" } })
blockrun_surf({ path: "onchain/sql", body: {
  sql: "SELECT token_address, count() FROM ethereum.dex_trades WHERE block_time > now() - INTERVAL 1 DAY GROUP BY 1 ORDER BY 2 DESC LIMIT 10"
}})                                                                                   // $0.0095
```

## blockrun_rpc — raw chain access

<!-- br:chains.rpc -->40<!-- /br:chains.rpc --> chains, one endpoint, no node, no key. $0.0040/call (batches charge per element, plus one flat fee per request). See [`skills/rpc/SKILL.md`](../rpc/SKILL.md).

```ts
blockrun_rpc({ network: "base", method: "eth_blockNumber", params: [] })
```

## Worked Examples

### 1. "What's BTC at?" — do not pay for this

```ts
blockrun_price({ action: "price", category: "crypto", symbol: "BTC-USD" })   // FREE
```

Not `blockrun_surf({ path: "market/price" })` — that is $0.0095 for an answer you can get free.

### 2. "Is this token legit?" ← compound, mostly free

```ts
blockrun_dex({ token: "0xCONTRACT" })                                        // FREE — liquidity, volume, pairs
blockrun_surf({ path: "token/holders", params: { address: "0xCONTRACT" } })  // concentration
blockrun_surf({ path: "token/tokenomics", params: { symbol: "TKN" } })       // unlock cliff coming?
```

Start free. Only pay once the free signal says it is worth a closer look.

### 3. "Who owns this wallet and what do they hold?"

```ts
blockrun_surf({ path: "wallet/labels/batch", params: { addresses: "0xWHALE" } })  // CEX? Whale? MEV bot?
blockrun_surf({ path: "wallet/net-worth",    params: { address: "0xWHALE" } })
blockrun_surf({ path: "wallet/protocols",    params: { address: "0xWHALE" } })    // Aave/Lido/Uni positions
```

### 4. "Where's the best yield right now?"

```ts
blockrun_defi({ path: "yields" })          // filter by chain/TVL/APY client-side — payload is large
blockrun_defi({ path: "chains" })          // where the money actually is
```

### 5. "Give me the macro picture"

```ts
blockrun_surf({ path: "market/etf",               params: { symbol: "BTC" } })
blockrun_surf({ path: "exchange/funding-history", params: { symbol: "BTCUSDT" } })
blockrun_surf({ path: "market/liquidation/chart" })
blockrun_surf({ path: "market/fear-greed" })
```

### 6. "Is gold up today?" — also free

```ts
blockrun_price({ action: "price", category: "commodity", symbol: "XAU-USD" })   // FREE
```

## Related

- **Prediction markets** (odds, smart money, wallet clustering) → [`skills/prediction-markets/SKILL.md`](../prediction-markets/SKILL.md)
- **Polymarket trading** (real money) → [`skills/polymarket-trading/SKILL.md`](../polymarket-trading/SKILL.md)
- **All 83 Surf endpoints** → [`skills/surf/SKILL.md`](../surf/SKILL.md)
- **Raw RPC** → [`skills/rpc/SKILL.md`](../rpc/SKILL.md)
