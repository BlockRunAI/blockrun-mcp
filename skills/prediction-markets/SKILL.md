---
name: prediction-markets
description: Use when the user asks about event probabilities, prediction market odds, what people are betting on, Polymarket/Kalshi prices, sports markets — or about the things you CANNOT get from a public API: historical price/volume/orderbook time series, smart-money positioning, whale leaderboards, wallet P&L, wallet identity and on-chain clustering, and canonical IDs matching the same question across venues. 58 endpoints over Polymarket, Kalshi, Limitless, Opinion, Predict.Fun, dFlow, Binance Futures, sports, and the UMA oracle. Pay-per-call in USDC via x402 — no Predexon account, no API key.
triggers:
  - "polymarket"
  - "kalshi"
  - "dflow"
  - "limitless"
  - "predict.fun"
  - "predexon"
  - "prediction market"
  - "event probability"
  - "betting odds"
  - "implied probability"
  - "what are people betting on"
  - "election odds"
  - "crypto market odds"
  - "binance futures"
  - "yes/no market"
  - "sports markets"
  - "smart money"
  - "smart wallet"
  - "whale"
  - "top traders"
  - "top holders"
  - "who is winning"
  - "best traders"
  - "copy trade"
  - "leaderboard"
  - "wallet pnl"
  - "wallet profit"
  - "trader performance"
  - "wallet identity"
  - "wallet cluster"
  - "price history"
  - "candles"
  - "candlestick"
  - "ohlcv"
  - "orderbook"
  - "order book history"
  - "open interest"
  - "volume history"
  - "trade history"
  - "cross-venue markets"
  - "arbitrage"
  - "uma oracle"
---

# Prediction Markets (Predexon)

58 endpoints across Polymarket, Kalshi, Limitless, Opinion, Predict.Fun, dFlow, Binance Futures, sports, and the UMA oracle — one x402 gateway, no Predexon account or API key.

**What is worth paying for.** Current market lists are free from public APIs. These are not, and cannot be backfilled after the fact:

- **History** — candlesticks, orderbook snapshots, volume charts, open interest, trade history. Built from continuous ingestion; nobody can reconstruct it retroactively.
- **Smart money** — leaderboards, cohort stats, top holders, which wallets are positioned where, and which markets high-performing wallets just entered.
- **Wallet intelligence** — profiles, P&L time series, identity metadata, and on-chain clustering (find the other wallets behind one address).
- **Cross-venue canonical IDs** — one question, matched across five venues. The basis for arbitrage and consensus.

## How to Call from MCP

One tool, three params. Method auto-routes: POST when `body` is set, GET otherwise.

```ts
blockrun_markets({ path: "polymarket/events", params: { limit: "10" } })

blockrun_markets({ path: "polymarket/candlesticks/0xCONDITION_ID", params: { interval: "1h" } })

blockrun_markets({ path: "polymarket/wallet/identities", body: {
  addresses: ["0xabc...", "0xdef..."]
}})
```

Paths are relative — no `/api/v1/pm/` prefix. Use `agent_id` to bill a child agent's budget.

## Two Pricing Tiers

| Tier | Price | What |
|---|---|---|
| **All endpoints** | $0.0095 | Market data, events, history, candles, orderbooks, trades, leaderboard, sports, UMA, wallet analytics, smart money, identity + clustering, cross-venue matching, Binance |

Pass-through pricing, 0% BlockRun margin — settles straight to Predexon's Base treasury.

## Quick Decision Table — "User asks about X"

| User wants… | path | Tier |
|---|---|---|
| **Same question across venues** | `markets` | 1 |
| **Search every venue at once** | `markets/search` | 2 |
| Venue-native tradable listings | `markets/listings` | 1 |
| Resolve a canonical outcome ID | `outcomes/{predexon_id}` | 1 |
| **Equivalent markets (arbitrage)** | `matching-markets` | 2 |
| Active matched pairs | `matching-markets/pairs` | 2 |
| Active Polymarket events | `polymarket/events` | 1 |
| Polymarket markets | `polymarket/markets` | 1 |
| Large result sets (stable paging) | `polymarket/markets/keyset` | 1 |
| Crypto up/down markets | `polymarket/crypto-updown` | 1 |
| Current/historical price of a token | `polymarket/market-price/{token_id}` | 1 |
| **Price history (OHLCV)** | `polymarket/candlesticks/{condition_id}` | 1 |
| **OHLCV for one outcome** | `polymarket/candlesticks/token/{token_id}` | 1 |
| **Volume over time (YES/NO split)** | `polymarket/volume-chart/{condition_id}` | 1 |
| **Historical orderbook snapshots** | `polymarket/orderbooks` | 1 |
| **Historical trades** | `polymarket/trades` | 1 |
| Merges / splits / redeems for a user | `polymarket/activity` | 1 |
| Cumulative volume for a market | `polymarket/markets/{token_id}/volume` | 1 |
| **Open interest history** | `polymarket/markets/{condition_id}/open_interest` | 1 |
| Positions (filterable) | `polymarket/positions` | 1 |
| **Global smart-wallet leaderboard** | `polymarket/leaderboard` | 1 |
| **Leaderboard for one market** | `polymarket/leaderboard/market/{condition_id}` | 1 |
| **Cohort performance by trading style** | `polymarket/cohorts/stats` | 1 |
| **Top holders of a market** | `polymarket/market/{condition_id}/top-holders` | 1 |
| **Smart money on a market** | `polymarket/market/{condition_id}/smart-money` | 2 |
| **Markets smart wallets just entered** | `polymarket/markets/smart-activity` | 2 |
| **Full smart-wallet profile** | `polymarket/wallet/{wallet}` | 2 |
| Per-market breakdown for a wallet | `polymarket/wallet/{wallet}/markets` | 2 |
| **Wallets with similar portfolios** | `polymarket/wallet/{wallet}/similar` | 2 |
| **Wallet P&L + realized series** | `polymarket/wallet/pnl/{wallet}` | 2 |
| Wallet open/historical positions | `polymarket/wallet/positions/{wallet}` | 2 |
| Wallet volume by BUY/SELL side | `polymarket/wallet/volume-chart/{wallet}` | 2 |
| Batch wallet profiles | `polymarket/wallets/profiles` | 2 |
| Filter wallets by markets traded | `polymarket/wallets/filter` | 2 |
| **Wallet identity (ENS/Twitter/etc)** | `polymarket/wallet/identity/{wallet}` | 2 |
| **Bulk identity (≤200, POST)** | `polymarket/wallet/identities` | 2 |
| **On-chain cluster for a wallet** | `polymarket/wallet/{address}/cluster` | 2 |
| UMA oracle questions by state | `polymarket/uma/markets` | 1 |
| UMA status + timeline for a market | `polymarket/uma/market/{condition_id}` | 1 |
| Kalshi markets | `kalshi/markets` | 1 |
| Kalshi trades / orderbooks | `kalshi/trades`, `kalshi/orderbooks` | 1 |
| Sports categories | `sports/categories` | 1 |
| Sports markets by league | `sports/markets` | 1 |
| One game, all venue outcomes | `sports/markets/{game_id}` | 1 |
| Equivalent sports outcomes | `sports/outcomes/{predexon_id}` | 1 |
| Limitless / Opinion / Predict.Fun markets | `limitless/markets`, `opinion/markets`, `predictfun/markets` | 1 |
| Their historical orderbook snapshots | `limitless/orderbooks`, `opinion/orderbooks`, `predictfun/orderbooks` | 1 |
| dFlow trades | `dflow/trades` | 1 |
| dFlow wallet positions / P&L | `dflow/wallet/positions/{w}`, `dflow/wallet/pnl/{w}` | 2 |
| Binance candles / ticks | `binance/candles/{symbol}`, `binance/ticks/{symbol}` | 2 |

## Worked Examples

### 1. "What are people betting on right now?"

```ts
blockrun_markets({ path: "polymarket/events", params: { limit: "10" } })
```

### 2. "What's the market saying about the 2028 election?"

Search every venue in one call, then resolve the canonical outcome.

```ts
blockrun_markets({ path: "markets/search", params: { q: "2028 presidential election" } })
blockrun_markets({ path: "outcomes/PXM-12345" })   // → venue listings + prices side by side
```

### 3. "Show me this market's price history" (impossible from a free API)

```ts
blockrun_markets({ path: "polymarket/candlesticks/0xCONDITION_ID", params: { interval: "1h" } })
blockrun_markets({ path: "polymarket/volume-chart/0xCONDITION_ID" })
blockrun_markets({ path: "polymarket/markets/0xCONDITION_ID/open_interest" })
```

### 4. "Who's smart money betting on in this market?" ← compound

Positioning → then profile the wallets behind it.

```ts
// 1. Which high-performing wallets are in this market, and on which side
blockrun_markets({ path: "polymarket/market/0xCONDITION_ID/smart-money" })

// 2. Profile the top wallet it returns — win rate, P&L, style
blockrun_markets({ path: "polymarket/wallet/0xWHALE" })

// 3. What else are they in right now?
blockrun_markets({ path: "polymarket/wallet/positions/0xWHALE" })
```

### 5. "This whale is up 400% — who are they really?" ← compound

Identity plus the on-chain cluster: one trader often runs many wallets.

```ts
blockrun_markets({ path: "polymarket/wallet/identity/0xWHALE" })        // ENS, socials, portfolio
blockrun_markets({ path: "polymarket/wallet/0xWHALE/cluster" })         // linked wallets + confidence
blockrun_markets({ path: "polymarket/wallet/pnl/0xWHALE" })             // realized P&L series
blockrun_markets({ path: "polymarket/wallet/0xWHALE/similar" })         // who trades like them
```

### 6. "Find me something to copy-trade" ← compound

```ts
blockrun_markets({ path: "polymarket/leaderboard", params: { limit: "20" } })   // best wallets
blockrun_markets({ path: "polymarket/markets/smart-activity" })                 // where they just moved
blockrun_markets({ path: "polymarket/cohorts/stats" })                          // which style is working
```

Then trade it with `blockrun_polymarket` (see `skills/polymarket-trading/SKILL.md`). **Real money — always dry-run first.**

### 7. "Is the same bet cheaper on another venue?" ← arbitrage

```ts
blockrun_markets({ path: "matching-markets", params: { status: "active" } })
blockrun_markets({ path: "matching-markets/pairs" })
```

### 8. "Who's ahead in tonight's NBA games?"

```ts
blockrun_markets({ path: "sports/markets", params: { league: "NBA", status: "open" } })
blockrun_markets({ path: "sports/markets/GAME_ID" })   // every venue's price for that game
```

### 9. "Is this market about to resolve?"

```ts
blockrun_markets({ path: "polymarket/uma/markets", params: { state: "proposed" } })
blockrun_markets({ path: "polymarket/uma/market/0xCONDITION_ID" })   // dispute timeline
```

## Method Routing — When to Use `body`

Almost everything is GET → use `params`. Only bulk identity takes a body:

```ts
blockrun_markets({ path: "polymarket/wallet/identities", body: { addresses: ["0x1", "0x2"] } })
```

## Paging Large Result Sets

Prefer keyset over offset — stable across writes, faster on big tables.

```ts
const p1 = blockrun_markets({ path: "polymarket/markets/keyset", params: { limit: "100" } })
// then pass the returned pagination.next_key back in:
blockrun_markets({ path: "polymarket/markets/keyset", params: { limit: "100", pagination_key: "<next_key>" } })
```

`polymarket/events/keyset` works the same way.

## Notes on Response Shape

Predexon returns raw upstream responses; shape varies by venue.

- **Polymarket** — usually `{ data: [...] }` or `{ events: [...] }`
- **Kalshi** — usually `{ markets: [...] }` with `ticker`, `yes_bid`, `no_bid`. Tickers look like `KXBTC-25MAR14` (series + expiry).
- **Canonical v2** — `{ markets: [...] }` with `predexon_id` + `venue_listings`
- Print the raw response when exploring a path you have not used before.

Prices are probabilities 0–1. `0.62` means the market implies 62%.

## Python SDK (for non-MCP use)

Inside the MCP, use `blockrun_markets` above. For standalone scripts:

```python
from blockrun_llm import setup_agent_wallet   # setup_agent_solana_wallet() on Solana
client = setup_agent_wallet()

client.pm("polymarket/candlesticks/0xCONDITION_ID", interval="1h")
client.pm_query("polymarket/wallet/identities", {"addresses": ["0xabc"]})
```

Requires `pip install blockrun-llm` and a funded USDC wallet (`client.get_balance()`).
