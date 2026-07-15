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

Real-time web + news search with AI-summarized results and citations. **PRICED PER SOURCE and expensive by default: $0.025 × `max_results`, +5% +$0.002 → default 10 settles $0.2645 per call.** Best for *fresh* queries; for semantic / neural research use `blockrun_exa` instead.

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
| `sources` | no | string[] | Subset of `["web","news"]`. Default: both. Does NOT multiply price. |
| `max_results` | no | number | 1–50, default 10. **Drives the price** — ~$0.0263 charged per source. Pass a small number to cap spend; the gateway prices the raw value and does not floor fractions. |
| `from_date` | no | string | `YYYY-MM-DD` lower bound on result date |
| `to_date` | no | string | `YYYY-MM-DD` upper bound |

## When to Reach for Which Source

| User intent | `sources` setting |
|---|---|
| Breaking news / today's headlines | `["news"]` |
| What's the CT / KOL sentiment on X | `["x"]` |
| Backgrounder / explainer / docs | `["web"]` |
| General "find current info" question | omit — defaults to all three |

## Worked Examples

### 1. "What's the latest on the ETH ETF approval timeline?"

```ts
blockrun_search({ body: { query: "Ethereum ETF approval SEC", sources: ["news","web"], max_results: 8 } })
```
**Cost: ~$0.2120** (8 sources: $0.025 × 8 × 1.05 + $0.002).

### 2. "What is X saying about Solana's latest outage?"

```ts
blockrun_search({ body: { query: "Solana outage today", sources: ["x"], max_results: 15 } })
```
**Cost: ~$0.3958** (15 sources: $0.025 × 15 × 1.05 + $0.002).

### 3. "Background on Pectra upgrade, last 90 days only"

```ts
blockrun_search({ body: {
  query: "Ethereum Pectra upgrade",
  sources: ["web","news"],
  from_date: "2026-02-17"
}})
```
**Cost: $0.2645** (10 sources, the default — verified live).

## search vs exa — Pick the Right Tool

| Use case | Tool |
|---|---|
| "What's happening *right now*?" — freshness matters | `blockrun_search` |
| "Find the canonical paper on X" — semantic relevance matters | `blockrun_exa` |
| "Pull the full text of these 5 URLs" — content fetch | `blockrun_exa` `contents` |
| "Cited answer to a question" | both work; `blockrun_exa answer` is grounded in pre-indexed corpus, `blockrun_search` searches the live web |

## Notes

- Returns AI-summarized text + a list of sources with URLs. The summary is one paragraph; sources let you drill in.
- **Price is per result, not per source.** `max_results: 20` with one source or three sources both cost $0.025 × 20 = $0.50. Pass a smaller `max_results` to cap spend.
- Date filters are strict — results outside the window are dropped, not down-ranked.

## Reference

- Endpoint: `POST /v1/search`
- Upstream: xAI Grok Live Search
