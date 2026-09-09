---
name: surf
description: "Surf (asksurf.ai) is RETIRED on BlockRun — the gateway has answered every /v1/surf/* path with HTTP 410 endpoint_retired since 2026-09-06, and blockrun_surf returns that notice free of charge. Use this skill when the user asks for Surf, asksurf, or the crypto data Surf used to serve — token prices, on-chain SQL, CEX order books, wallet labels/net worth, social mindshare, news, unified search — so the request is routed to the tool that serves it now (blockrun_price, blockrun_dex, blockrun_defi, blockrun_markets, blockrun_rpc) or told honestly that nothing on BlockRun serves it yet."
triggers:
  - "surf"
  - "asksurf"
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

# Surf — retired on BlockRun (2026-09-06)

Surf (asksurf.ai) is no longer served through BlockRun. Since **2026-09-06** the
gateway answers every `/v1/surf/*` path with:

```
HTTP 410
{"error":{"code":"endpoint_retired","message":"The Surf data endpoints are retired. We are looking for a new vendor in this space and expect to publish a replacement under /api/v1/."},
 "retired_on":"2026-09-06",
 "alternatives":[{"for":"crypto, equity, FX and commodity prices","endpoint":"/api/v1/crypto/price"},
                 {"for":"protocol TVL and yields","endpoint":"/api/v1/defillama/*"},
                 {"for":"prediction markets","endpoint":"/api/v1/pm/*"},
                 {"for":"DEX quotes and swaps","endpoint":"/api/v1/zerox/*"}]}
```

Verified live 2026-09-08 with an unauthenticated GET (a 410 is free to fetch).
`sol.blockrun.ai` answers 404 on the same paths, and `/api/openapi` no longer
lists any Surf route. **No 402 is ever issued, so no payment can be made.**

`blockrun_surf` stays registered so existing configs and the `trading` /
`research` profiles keep working, but every call returns the retirement notice
**before** any budget is reserved or a spend-confirmation dialog is shown.
Nothing is charged. Do not retry it, and do not tell the user it is a temporary
outage — it is not.

## Where each former Surf capability lives now

| The user wants… | Surf used to be | Use now | Cost |
|---|---|---|---|
| BTC/ETH/any coin price, OHLC history | `market/price`, `exchange/klines` | `blockrun_price` action:"price" / "history" category:"crypto" | **FREE** |
| FX, gold, oil | `market/price` | `blockrun_price` category:"fx" / "commodity" | **FREE** |
| Fear & Greed, market ranking by cap | `market/fear-greed`, `market/ranking` | `blockrun_price` action:"list" for the symbol universe; no sentiment index on BlockRun | FREE / none |
| DEX pair, liquidity, volume, token by contract | `token/dex-trades`, `search/project` | `blockrun_dex` | **FREE** |
| Token price by contract address | `market/price` | `blockrun_defi` path:"prices/{coins}" | $0.001 + fee |
| Protocol / chain TVL, yield rankings | `project/defi/ranking`, `onchain/yield/ranking` | `blockrun_defi` path:"protocols" / "chains" / "yields" | $0.005 + fee |
| Polymarket / Kalshi markets, prices, positions | `prediction-market/*`, `search/polymarket`, `search/kalshi` | `blockrun_markets` — see [`skills/prediction-markets/SKILL.md`](../prediction-markets/SKILL.md) | $0.0075 + fee |
| Who is this Polymarket wallet, and which wallets are theirs | `wallet/detail`, `wallet/labels/batch` (for Polymarket traders only) | `blockrun_markets` `polymarket/wallet/identity/{wallet}` + `polymarket/wallet/{address}/cluster` | $0.0075 + fee |
| Gas price, a transaction, a balance, a contract read | `onchain/gas-price`, `onchain/tx` | `blockrun_rpc` (`eth_gasPrice`, `eth_getTransactionByHash`, `eth_getBalance`, `eth_call`) — see [`skills/rpc/SKILL.md`](../rpc/SKILL.md) | $0.002 + fee |
| Web / news search | `search/web`, `search/news`, `news/feed` | `blockrun_exa` (neural) or `blockrun_search` (Grok Live Search, web + X + news) | $0.01 + fee / $0.025 × results |

"fee" is the gateway's flat network fee — $0.001 per call on Base today; the
Solana gateway quotes the base alone; the account rail charges no fee.

## What has NO replacement on BlockRun yet

Say so plainly rather than substituting something that answers a different question:

- **Raw on-chain SQL** over ClickHouse (`onchain/sql`, `onchain/query`, `onchain/schema`)
- **Wallet labels and net worth across 13 chains** for arbitrary addresses (`wallet/labels/batch`, `wallet/net-worth`, `wallet/protocols`, `wallet/history`). Only Polymarket traders are covered, via `blockrun_markets` identity/cluster above.
- **CEX order books, perp snapshots, funding history, long/short ratio, options skew** (`exchange/*`, `market/options`, `market/futures`)
- **ETF flows, liquidation charts, on-chain indicators** (`market/etf`, `market/liquidation/*`, `market/onchain-indicator`)
- **Social / CT intelligence** — mindshare, smart followers, KOL search, tweet search (`social/*`, `search/social/*`)
- **Tokenomics and unlock schedules, token holders and transfers** (`token/*`)
- **VC fund portfolios and rankings** (`fund/*`)
- **Bridge rankings, airdrop search, project profiles** (`onchain/bridge/ranking`, `search/airdrop`, `project/detail`)
- **Webpage-to-markdown** (`web/fetch`)

The gateway says a new vendor is pending and that the replacement will be
published under `/api/v1/` and listed at `https://blockrun.ai/api/openapi`. Check
there before promising any of the above.

## Worked example — what a former Surf request looks like now

**"Is this whale wallet labeled, and what does it hold?"** (was 4 Surf calls, $0.034)

```ts
// If it is a Polymarket trader — identity, linked wallets, P&L:
blockrun_markets({ path: "polymarket/wallet/identity/0xWHALE" })
blockrun_markets({ path: "polymarket/wallet/0xWHALE/cluster" })
blockrun_markets({ path: "polymarket/wallet/pnl/0xWHALE" })

// For any address — current native + token balances via raw RPC (free tools first):
blockrun_rpc({ network: "ethereum", method: "eth_getBalance", params: ["0xWHALE", "latest"] })
```

Cross-chain labels (CEX / MEV / bridge) and a net-worth time series are not
available on BlockRun right now — tell the user that, do not call `blockrun_surf`.

## Reference

- Gateway retirement notice: `curl -s https://blockrun.ai/v1/surf/market/price` (HTTP 410, free)
- Live route catalog: https://blockrun.ai/api/openapi
- Related skills: [`crypto-data`](../crypto-data/SKILL.md) · [`prediction-markets`](../prediction-markets/SKILL.md) · [`rpc`](../rpc/SKILL.md)
