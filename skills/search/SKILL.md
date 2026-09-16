---
name: search
description: Use when the user wants real-time web or news results with AI-summarized answers and citations — Grok Live Search via BlockRun. Cheapest path for "what just happened" questions where freshness beats neural-semantic ranking.
triggers:
  - "live search"
  - "grok live"
  - "what just happened"
  - "real time news"
  - "breaking news"
  - "today's news"
  - "search with citations"
  - "cited search"
  - "news search"
---

# Live Search (Grok)

Real-time web + news search with AI-summarized results and citations. **PRICED PER SOURCE and expensive by default: $0.025 × `max_results`, +5% +$0.001 → default 10 settles $0.2635 per call.** Best for *fresh* queries; for semantic / neural research use `blockrun_exa` instead.

## How to Call from MCP

```ts
blockrun_search({ body: {
  query: "what's the consensus on the Fed's next move",
  sources: ["web", "news"],
  max_results: 10
}})
```

## Body Shape

| Field | Required | Type | Notes |
|---|---|---|---|
| `query` | yes | string | Natural-language search query |
| `sources` | no | string[] | Subset of `["web","news"]`. Default: `["web"]` — pass both for news coverage. There is no X/Twitter source (removed upstream 2026-07-05; asking for `"x"` is refused before payment). Does NOT multiply price. |
| `max_results` | no | number | 1–50, default 10. **Drives the price** — ~$0.0263 charged per source. Pass a small number to cap spend; the gateway prices the raw value and does not floor fractions. |
| `from_date` | no | string | `YYYY-MM-DD` lower bound on result date |
| `to_date` | no | string | `YYYY-MM-DD` upper bound |

## When to Reach for Which Source

| User intent | `sources` setting |
|---|---|
| Breaking news / today's headlines | `["news"]` |
| Social / X sentiment | not served — there is no X source; use `["news","web"]` and say so, or `blockrun_exa` for a targeted crawl |
| Backgrounder / explainer / docs | `["web"]` |
| General "find current info" question | `["web","news"]` (omitting it searches the web only) |

## Worked Examples

### 1. "What's the latest on the ETH ETF approval timeline?"

```ts
blockrun_search({ body: { query: "Ethereum ETF approval SEC", sources: ["news","web"], max_results: 8 } })
```
**Cost: ~$0.2110** (8 sources: $0.025 × 8 × 1.05 + $0.001).

### 2. "What happened in Solana's latest outage?"

```ts
blockrun_search({ body: { query: "Solana outage today", sources: ["news","web"], max_results: 15 } })
```
**Cost: ~$0.3948** (15 sources: $0.025 × 15 × 1.05 + $0.001). There is no
X/Twitter source: `sources: ["x"]` is refused before payment with the live
list, so do not promise "what X is saying" — say what the news and web say.

### 3. "Background on Pectra upgrade, last 90 days only"

```ts
blockrun_search({ body: {
  query: "Ethereum Pectra upgrade",
  sources: ["web","news"],
  from_date: "2026-02-17"
}})
```
**Cost: $0.2635** (10 sources, the default — verified live).

## search vs exa — Pick the Right Tool

| Use case | Tool |
|---|---|
| "What's happening *right now*?" — freshness matters | `blockrun_search` |
| "Find the canonical paper on X" — semantic relevance matters | `blockrun_exa` |
| "Pull the full text of these 5 URLs" — content fetch | `blockrun_exa` `contents` |
| "Cited answer to a question" | both work; `blockrun_exa answer` is grounded in pre-indexed corpus, `blockrun_search` searches the live web |

## Notes

- Returns AI-summarized text + a list of sources with URLs. The summary is one paragraph; sources let you drill in.
- **Price is per result, not per source.** `max_results: 20` with one source or three sources both charge **$0.526** ($0.025 × 20 × 1.05 + $0.001 — verified live). Pass a smaller `max_results` to cap spend.
- Date filters are strict — results outside the window are dropped, not down-ranked.

## Reference

- Endpoint: `POST /v1/search`
- Upstream: xAI Grok Live Search
