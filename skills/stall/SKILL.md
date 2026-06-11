---
name: stall
description: Use when an agent needs financial data, market intelligence, or economic data that isn't available from blockrun_markets, blockrun_price, or blockrun_surf. The Stall covers 209 pay-per-call capabilities: US/EU/JP/KR/AU equities, dealer gamma exposure (GEX), DeFi/Polymarket, GDELT global news synthesis, SEC/EDGAR filings, congressional trades, insider activity, 85-year ERA5 climate history, Twitter/X intelligence, Reddit social momentum, and more. USDC on Base; no API keys.
triggers:
  - "stock price"
  - "stock history"
  - "earnings"
  - "dividends"
  - "analyst estimates"
  - "japanese stock"
  - "korean stock"
  - "australian stock"
  - "european stock"
  - "eu stock"
  - "dealer gamma"
  - "gamma exposure"
  - "GEX"
  - "gamma flip"
  - "vol regime"
  - "options microstructure"
  - "congressional trades"
  - "insider trades"
  - "SEC filing"
  - "EDGAR"
  - "regulatory filing"
  - "sanctions"
  - "GDELT"
  - "global news"
  - "reddit momentum"
  - "hacker news"
  - "social momentum"
  - "climate history"
  - "weather history"
  - "ERA5"
  - "air quality"
  - "treasury rates"
  - "yield curve"
  - "FRED data"
  - "World Bank"
  - "patent search"
  - "wayback machine"
  - "internet archive"
  - "meme coin"
  - "solana dex"
  - "defi tvl"
  - "defillama"
  - "polymarket"
  - "prediction market"
  - "twitter intel"
  - "tweet search"
  - "X intelligence"
  - "company due diligence"
  - "sanctions check"
---

# The Stall — 209 Pay-Per-Call AI Data Capabilities

The Stall is an x402-native data server built by IntuiTek¹. 209 capabilities, no API keys, USDC on Base. BlockRun routes to `https://the-stall.intuitek.ai` and settles directly to The Stall's Base treasury.

Complementary to `blockrun_surf` (on-chain/crypto SQL) and `blockrun_markets` (prediction market aggregation) — The Stall covers equities, macro, regulatory, climate, social, and specialized research that neither of those tools reaches.

## How to Call from MCP

One tool, two params. All calls are GET with query params:

```ts
blockrun_stall({ cap: "us-stock-price", params: { ticker: "AAPL" } })
blockrun_stall({ cap: "market-gex", params: { ticker: "SPY", days_out: "21" } })
blockrun_stall({ cap: "global-news-intel", params: { topic: "federal reserve" } })
```

Full cap list: `curl https://the-stall.intuitek.ai/health | jq '.capabilities'`

## Pricing Tiers

| Tier | Price | Used by |
|------|-------|---------|
| Low | $0.001–$0.005 | Macro reads (Treasury, FRED, FX), news synthesis, weather, DeFi TVL, social signals |
| Mid | $0.007–$0.020 | Equities (all markets), GEX, options data, SEC filings, insider/congressional trades, social intel |
| High | $0.030–$0.065 | Synthesis caps (due diligence, strategy signal, portfolio risk, patent search) |

All prices from the live 402 response — `estimateStallCost` is a local budget guard only.

## Quick Decision Table

| User wants… | Cap | Required params | Price |
|---|---|---|---|
| US stock current price | `us-stock-price` | `ticker` | $0.018 |
| US stock OHLCV history | `us-stock-history` | `ticker`, `period` (1d/5d/1mo/3mo/1y) | $0.012 |
| US stock earnings/financials | `us-stock-financials` | `ticker` | $0.015 |
| US stock recent news | `us-stock-news` | `ticker` | $0.012 |
| EU stock price | `eu-stock-price` | `ticker` (e.g. ASML.AS) | $0.015 |
| Japan stock price | `jp-stock-price` | `ticker` (e.g. 7203.T) | $0.015 |
| Korea stock price | `kr-stock-price` | `ticker` (e.g. 005930.KS) | $0.015 |
| Australia stock price | `au-stock-price` | `ticker` (e.g. BHP.AX) | $0.015 |
| Dealer GEX for any ticker | `market-gex` | `ticker`, `days_out` (opt, default 45) | $0.020 |
| Options chain | `options-chain` | `ticker`, `expiry` (opt) | $0.018 |
| Congressional stock trades | `congressional-trades` | `ticker` (opt), `days` (opt, default 30) | $0.008 |
| Insider filings | `insider-trades` | `ticker` | $0.008 |
| SEC/EDGAR filings search | `sec-edgar-search` | `q` (keyword) | $0.007 |
| Specific SEC filing | `sec-edgar-filing` | `ticker`, `form` (10-K/10-Q/8-K) | $0.010 |
| Sanctions/watchlist check | `sanctions-check` | `name` or `address` | $0.008 |
| GDELT global news synthesis | `global-news-intel` | `topic` | $0.003 |
| Reddit social momentum | `reddit-intel` | `ticker` or `topic` | $0.010 |
| Hacker News intelligence | `hackernews-intel` | `topic` | $0.005 |
| Twitter/X user profile | `twitter-intel` | `action=lookup_user`, `handle` | $0.015 |
| Twitter/X tweet search | `twitter-intel` | `action=search_tweets`, `query` | $0.015 |
| Live US Treasury yields | `treasury-rates` | `maturity` (1M/3M/6M/1Y/2Y/5Y/10Y/30Y) | $0.001 |
| Full yield curve | `yield-curve` | – | $0.002 |
| FRED economic series | `fred-series` | `series_id` (e.g. UNRATE, CPI, GDP) | $0.002 |
| G10 FX rates | `forex-rates` | `base` (USD/EUR/etc), `pairs` (opt) | $0.002 |
| World Bank GDP/inflation | `world-bank-data` | `country`, `indicator` | $0.003 |
| DeFi protocol TVL | `defi-tvl` | `protocol` | $0.003 |
| DeFi yield pools | `defi-yields` | `chain` (opt), `min_apy` (opt) | $0.003 |
| Polymarket prediction | `polymarket-intel` | `query` | $0.008 |
| 85-year climate history | `climate-history` | `lat`, `lon`, `years` (opt, default 30) | $0.005 |
| Live weather | `weather` | `lat`, `lon` or `city` | $0.002 |
| Air quality index | `air-quality` | `lat`, `lon` or `city` | $0.002 |
| Patent search | `patent-search` | `q`, `limit` (opt) | $0.040 |
| Wayback Machine archive | `wayback-intel` | `url`, `year` (opt) | $0.003 |
| Solana meme token radar | `meme-radar` | `limit` (opt, default 10) | $0.005 |
| Company due diligence | `company-due-diligence` | `company` or `ticker` | $0.060 |
| Technical strategy signal | `strategy-signal` | `ticker` | $0.065 |

## Worked Examples

### 1. "What's Apple's stock price and how has it moved this week?"

```ts
// Current price
blockrun_stall({ cap: "us-stock-price", params: { ticker: "AAPL" } })
// 5-day history
blockrun_stall({ cap: "us-stock-history", params: { ticker: "AAPL", period: "5d" } })
```
**Cost: $0.018 + $0.012 = $0.030.** Returns price, volume, market cap, 52-week range.

### 2. "Is SPY pinned? What's the gamma flip level?"

```ts
blockrun_stall({ cap: "market-gex", params: { ticker: "SPY", days_out: "21" } })
```
**Cost: $0.020.** Returns `total_gex` (positive = dealers are long gamma / pinning effect), `gamma_flip` (the strike where net GEX crosses zero), `vol_regime` (pinned/neutral/acceleration), and the top GEX-contributing strikes. Methodology: standard SpotGamma-style dealer gamma calculation from CBOE delayed options data — same approach as paid services at $1,200/year.

### 3. "Have any senators or reps traded NVDA recently?"

```ts
blockrun_stall({ cap: "congressional-trades", params: { ticker: "NVDA", days: "60" } })
```
**Cost: $0.008.** Returns trades from the STOCK Act filings: politician name, party, trade date, action (buy/sell), estimated amount range, filing date.

### 4. "What's the global news on the Federal Reserve this week?"

```ts
blockrun_stall({ cap: "global-news-intel", params: { topic: "Federal Reserve interest rates" } })
```
**Cost: $0.003.** GDELT indexes 100+ languages across 215 countries. Returns a synthesized summary of 24h coverage with source count, sentiment, geographic spread, and top article links.

### 5. "Run a full macro snapshot: yields + FX + FRED unemployment"

```ts
// 10Y Treasury
blockrun_stall({ cap: "treasury-rates", params: { maturity: "10Y" } })
// Full yield curve
blockrun_stall({ cap: "yield-curve" })
// EUR/USD
blockrun_stall({ cap: "forex-rates", params: { base: "USD" } })
// FRED unemployment rate
blockrun_stall({ cap: "fred-series", params: { series_id: "UNRATE" } })
```
**Cost: 4 × ~$0.002 = $0.008.** All free-tier macro reads.

### 6. "What was the climate like in NYC 30 years ago vs. today?"

```ts
blockrun_stall({ cap: "climate-history", params: { lat: "40.7128", lon: "-74.0060", years: "30" } })
```
**Cost: $0.005.** ERA5 reanalysis data. Returns 30-year monthly averages for temperature, precipitation, humidity vs. the most recent year — useful for long-horizon climate trend analysis.

### 7. "Is this wallet sanctioned? Check OFAC, UN, EU lists."

```ts
blockrun_stall({ cap: "sanctions-check", params: { address: "0xd882cfc20f52f2599d84b8e8d58c7fb62cfe344b" } })
```
**Cost: $0.008.** Checks OFAC SDN, UN Security Council, EU Consolidated, UK HMT, and FATF grey/black lists. Returns `sanctioned: true/false`, matched lists, and entity name if found.

### 8. "What's trending on Reddit about Tesla?"

```ts
blockrun_stall({ cap: "reddit-intel", params: { ticker: "TSLA" } })
```
**Cost: $0.010.** Returns post volume trend (7d), sentiment score, top posts with engagement, subreddit breakdown (r/wallstreetbets, r/investing, r/stocks, etc.).

### 9. "Full due diligence on Anthropic"

```ts
blockrun_stall({ cap: "company-due-diligence", params: { company: "Anthropic" } })
```
**Cost: $0.060.** Multi-source synthesis: SEC/EDGAR if public, news coverage (GDELT), web intelligence, recent filings, leadership, funding history, competitive position. Returns a structured report.

### 10. "What's the Wayback Machine snapshot of OpenAI's homepage from 2020?"

```ts
blockrun_stall({ cap: "wayback-intel", params: { url: "https://openai.com", year: "2020" } })
```
**Cost: $0.003.** Returns the closest archived snapshot URL + extracted text content from the Internet Archive.

## Gotchas

- **All caps are GET with query params** — unlike blockrun_surf/blockrun_exa, there are no POST endpoints. Pass everything in `params`.
- **EU/JP/KR/AU stock tickers require the exchange suffix**: ASML.AS (Amsterdam), 7203.T (Tokyo), 005930.KS (Korea), BHP.AX (ASX). US tickers are bare (AAPL, not AAPL.US).
- **`market-gex` uses CBOE delayed data** (15-min delay for US equities). Suitable for positioning/regime analysis, not for intraday HFT.
- **`twitter-intel` requires `action` param**: `action=lookup_user` (profile) or `action=search_tweets` (keyword search). Settles upstream via twit.sh x402 relay.
- **`climate-history` uses ERA5 reanalysis** — gridded model output, not station observations. Accuracy ±0.1°C monthly average.
- **`patent-search` returns US patents via USPTO**. International patents not included.
- **Missing required param → 400 without charge** — The Stall validates before settling.

## Reference

- Full health + cap list: https://the-stall.intuitek.ai/health
- Well-known x402 pricing: https://the-stall.intuitek.ai/.well-known/x402
- MCP endpoint (free): https://the-stall.intuitek.ai/mcp
- Publisher: IntuiTek¹ — kyle@intuitek.ai
- Settlement wallet (Base): 0x03d773c52B67993e60Ecb3134b17436fE03B584c
