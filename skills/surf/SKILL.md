---
name: surf
description: "Surf (asksurf.ai) is RETIRED on BlockRun and the blockrun_surf tool was REMOVED in 0.49.0 — the gateway has answered every /v1/surf/* path with HTTP 410 endpoint_retired since 2026-09-06. Use this skill to route a former Surf question (on-chain SQL, wallet labels and net worth, CEX order books, social mindshare, news) to the tool that still serves it, and to say plainly what has no replacement yet."
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

`blockrun_surf` was **removed from the server in 0.49.0** and is no longer one of
the <!-- br:mcp.tools -->19<!-- /br:mcp.tools --> tools: a tool that can only
return an error is not worth the schema every agent carries on every turn. An
MCP client will answer an unknown-tool error if a config still names it. Nothing
can be charged either way. Do not describe this as a temporary outage — it is
not; route the question with the table below.

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
available on BlockRun right now — tell the user that. `blockrun_surf` no longer exists.

## Reference

- Gateway retirement notice: `curl -s https://blockrun.ai/v1/surf/market/price` (HTTP 410, free)
- Live route catalog: https://blockrun.ai/api/openapi
- Related skills: [`crypto-data`](../crypto-data/SKILL.md) · [`prediction-markets`](../prediction-markets/SKILL.md) · [`rpc`](../rpc/SKILL.md)
