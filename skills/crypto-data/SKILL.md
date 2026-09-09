---
name: crypto-data
description: "Use for any crypto data question — token/coin prices, FX, commodities, stocks, OHLC history, DEX pairs and liquidity, DeFi TVL, yield/APY pools, or raw JSON-RPC against a chain; also when the user asks for on-chain SQL, wallet labels/net worth, social mindshare or crypto news, so they are told plainly what BlockRun serves and what it does not. Routes across four live tools that overlap and says which one to use and which are FREE — blockrun_price (crypto/FX/commodities free, Pyth), blockrun_dex (free, DexScreener), blockrun_defi (DefiLlama TVL + yields), blockrun_rpc (40 chains). blockrun_surf is retired (gateway 410 since 2026-09-06) and must not be called for data. No API keys, pay-per-call in USDC via x402."
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

Four live tools cover crypto data and they overlap. **Pick by cost first** — two of them are free, and paying for a quote you could get for nothing is the most common mistake here.

A fifth tool, `blockrun_surf`, was **removed in 0.49.0**: the gateway has answered every Surf path with HTTP 410 since 2026-09-06. Do not name it; the [`surf` skill](../surf/SKILL.md) maps each former Surf capability to where it lives now — and lists the ones (on-chain SQL, cross-chain wallet labels, social mindshare, CEX order books) that have no BlockRun source yet.

## Route by cost — check this before calling anything

| Question | Tool | Cost |
|---|---|---|
| **What's BTC/ETH/any coin worth right now?** | `blockrun_price` action:"price" category:"crypto" | **FREE** |
| **Crypto OHLC history** | `blockrun_price` action:"history" category:"crypto" | **FREE** |
| **FX rate / commodity (gold, oil)** | `blockrun_price` category:"fx" or `"commodity"` | **FREE** |
| **Which symbols exist?** | `blockrun_price` action:"list" | **FREE** |
| **DEX pair, liquidity, volume, contract** | `blockrun_dex` | **FREE** |
| Stock ticker catalog (12 markets) | `blockrun_price` action:"list" category:"stocks" | **FREE** — quotes/history withdrawn 2026-09-05 (501) |
| Token price by contract address | `blockrun_defi` path:"prices/{coins}" | $0.0020 |
| Raw JSON-RPC on <!-- br:chains.rpc -->40<!-- /br:chains.rpc --> chains | `blockrun_rpc` | $0.0030 |
| Protocol TVL, chain TVL, yields/APY | `blockrun_defi` | $0.0060 |
| Who a Polymarket wallet is, and which wallets are linked to it | `blockrun_markets` `polymarket/wallet/identity/{w}`, `.../cluster` | $0.0085 |
| On-chain SQL, cross-chain wallet labels / net worth, social mindshare, CEX order books, ETF flows, unlocks | **nothing on BlockRun yet** — Surf retired 2026-09-06; say so | — |

Every price below is what x402 actually **charges on Base** (the base plus the gateway's $0.001 flat fee), verified against live `payment-required` headers — not the base you may see in a 402 body. The Solana gateway quotes the base alone; the account rail charges no fee.

**The rule:** a plain crypto price or a DEX pair is free. When the question needs something the four live tools do not have — labels, SQL, social, news, unlocks — tell the user BlockRun does not serve it right now. The tool that used to (`blockrun_surf`) was removed in 0.49.0.

**Prediction markets go to `blockrun_markets`** (Predexon): Polymarket, Kalshi, Limitless, Opinion and Predict.Fun, plus wallet clustering, smart money and UMA. For sports odds use `markets/search` with `{ q: "NBA" }` or `polymarket/events` with `{ search: "NBA" }` — the dedicated `sports/*` routes are degraded upstream, and the bare `markets` route with a `league` filter was removed on 2026-08-04 and 404s. Route odds, positions and market history to [`skills/prediction-markets/SKILL.md`](../prediction-markets/SKILL.md).

## blockrun_price — quotes & history (Pyth-backed)

Free for crypto, FX and commodities. Equity is catalog-only: since 2026-09-05 the gateway answers `stocks` price/history with a pre-payment 501 ("We do not currently serve equity prices") — nothing is charged, retrying does not help, and the user should contact hello@blockrun.ai for equity coverage. `action:"list"` still returns the ticker catalog for free.

```ts
blockrun_price({ action: "price",   category: "crypto",    symbol: "BTC-USD" })            // FREE
blockrun_price({ action: "history", category: "crypto",    symbol: "ETH-USD",
                 resolution: "1h", from: 1750000000, to: 1750086400 })                     // FREE
blockrun_price({ action: "price",   category: "fx",        symbol: "EUR-USD" })            // FREE
blockrun_price({ action: "price",   category: "commodity", symbol: "XAU-USD" })            // FREE — gold
blockrun_price({ action: "list",    category: "crypto" })                                  // FREE — discovery
blockrun_price({ action: "list",    category: "stocks",    market: "us", query: "AAPL" })   // FREE — catalog only; price/history → 501
```

Stock markets: `us`, `hk`, `jp`, `kr`, `gb`, `de`, `fr`, `nl`, `ie`, `lu`, `cn`, `ca` — `market` is required when `category:"stocks"`. Do not call `action:"price"` or `"history"` on `stocks`: the gateway does not serve equity quotes right now.

## blockrun_dex — DEX pairs & liquidity (DexScreener)

Free, no payment. Use it for anything pair- or contract-shaped.

```ts
blockrun_dex({ query: "SOL" })                      // search pairs
blockrun_dex({ symbol: "PEPE" })                    // search by symbol
blockrun_dex({ token: "So11111111111111111111111111111111111111112" })  // one token
blockrun_dex({ query: "WETH", chain: "base" })      // scope to a chain
```

## blockrun_defi — TVL & yields (DefiLlama)

Path-based, GET only. **Base only in wallet mode; fine on an API key** — `sol.blockrun.ai` does not serve `/v1/defillama/*`
and answers `404`, which reads like a bad path rather than a wrong chain. The tool checks
the active chain and refuses with that explanation before spending the round trip; if the
user needs DeFi data, switch back with `blockrun_wallet action:"chain" chain:"base"`.

| path | cost | returns |
|---|---|---|
| `protocols` | $0.0060 | every DeFi protocol ranked by TVL |
| `protocol/{slug}` | $0.0060 | one protocol's TVL history + chain breakdown |
| `chains` | $0.0060 | TVL by chain |
| `yields` | $0.0060 | yield pools with APY + TVL (large — filter client-side) |
| `prices/{coins}` | $0.0020 | token prices by contract, e.g. `base:0x8335…,coingecko:ethereum` |

```ts
blockrun_defi({ path: "protocol/aave-v3" })
blockrun_defi({ path: "chains" })
blockrun_defi({ path: "yields" })                   // big payload — filter after
blockrun_defi({ path: "prices/coingecko:ethereum" })
```

## blockrun_surf — removed 2026-09-06 (tool dropped in 0.49.0)

The gateway answers every `/v1/surf/*` path with `410 endpoint_retired` (verified live 2026-09-08; `sol.blockrun.ai` 404s; `/api/openapi` lists no Surf route), so the tool was removed from the server rather than left to return an error. It is not one of the <!-- br:mcp.tools -->19<!-- /br:mcp.tools --> tools. Route former Surf questions to `blockrun_price`, `blockrun_dex`, `blockrun_defi`, `blockrun_markets` or `blockrun_rpc`; see [`skills/surf/SKILL.md`](../surf/SKILL.md) for the endpoint-by-endpoint map and for what has no replacement.

## blockrun_rpc — raw chain access

<!-- br:chains.rpc -->40<!-- /br:chains.rpc --> chains, one endpoint, no node, no key. $0.0030/call (batches charge per element, plus one flat fee per request). See [`skills/rpc/SKILL.md`](../rpc/SKILL.md).

```ts
blockrun_rpc({ network: "base", method: "eth_blockNumber", params: [] })
```

## Worked Examples

### 1. "What's BTC at?" — do not pay for this

```ts
blockrun_price({ action: "price", category: "crypto", symbol: "BTC-USD" })   // FREE
```

Not `blockrun_surf` — it no longer exists (removed in 0.49.0); before 2026-09-06 it charged $0.0085 for an answer you can get free.

### 2. "Is this token legit?" ← compound, mostly free

```ts
blockrun_dex({ token: "0xCONTRACT" })                                        // FREE — liquidity, volume, pairs, age
blockrun_defi({ path: "prices/base:0xCONTRACT" })                            // $0.0020 — is it priced by DefiLlama at all?
blockrun_rpc({ network: "base", method: "eth_call", params: [{ to: "0xCONTRACT", data: "0x18160ddd" }, "latest"] })  // totalSupply()
```

Start free. Only pay once the free signal says it is worth a closer look. Holder concentration and unlock schedules were Surf features and have no BlockRun source right now — say so rather than guessing.

### 3. "Who owns this wallet and what do they hold?"

```ts
// A Polymarket trader: identity, linked wallets, P&L — via Predexon
blockrun_markets({ path: "polymarket/wallet/identity/0xWHALE" })
blockrun_markets({ path: "polymarket/wallet/0xWHALE/cluster" })
blockrun_markets({ path: "polymarket/wallet/pnl/0xWHALE" })

// Any address: balances via raw RPC
blockrun_rpc({ network: "ethereum", method: "eth_getBalance", params: ["0xWHALE", "latest"] })
```

Cross-chain labels (CEX / MEV / bridge), net-worth history and DeFi position breakdowns were Surf features; nothing on BlockRun serves them today.

### 4. "Where's the best yield right now?"

```ts
blockrun_defi({ path: "yields" })          // filter by chain/TVL/APY client-side — payload is large
blockrun_defi({ path: "chains" })          // where the money actually is
```

### 5. "Give me the macro picture"

```ts
blockrun_price({ action: "price", category: "crypto",    symbol: "BTC-USD" })   // FREE
blockrun_price({ action: "price", category: "commodity", symbol: "XAU-USD" })   // FREE — gold
blockrun_price({ action: "price", category: "fx",        symbol: "EUR-USD" })   // FREE
blockrun_defi({ path: "chains" })                                               // $0.0060 — where DeFi capital sits
blockrun_markets({ path: "markets/search", params: { q: "bitcoin", status: "open" } })  // $0.0085 — what the crowd is pricing
```

ETF flows, funding rates, liquidation charts and the Fear & Greed index were Surf features with no BlockRun source today.

### 6. "Is gold up today?" — also free

```ts
blockrun_price({ action: "price", category: "commodity", symbol: "XAU-USD" })   // FREE
```

## Related

- **Prediction markets** (odds, smart money, wallet clustering) → [`skills/prediction-markets/SKILL.md`](../prediction-markets/SKILL.md)
- **Polymarket trading** (real money) → [`skills/polymarket-trading/SKILL.md`](../polymarket-trading/SKILL.md)
- **Surf is retired** — what replaced each former endpoint → [`skills/surf/SKILL.md`](../surf/SKILL.md)
- **Raw RPC** → [`skills/rpc/SKILL.md`](../rpc/SKILL.md)
