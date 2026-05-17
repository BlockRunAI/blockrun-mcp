---
name: search
description: Use when the user wants real-time web, news, or X/Twitter results with AI-summarized answers and citations — Grok Live Search via BlockRun. Cheapest path for "what just happened" questions where freshness beats neural-semantic ranking.
triggers:
  - "live search"
  - "grok live"
  - "what just happened"
  - "real time news"
  - "breaking news"
  - "today's news"
  - "search with citations"
  - "cited search"
  - "x search"
  - "twitter search"
  - "news search"
---

# Live Search (Grok)

Real-time web + X/Twitter + news search with AI-summarized results and citations. ~$0.025 per source returned. Best for *fresh* queries; for semantic / neural research use `blockrun_exa` instead.

## How to Call from MCP

```ts
blockrun_search({ body: {
  query: "what's the consensus on the Fed's next move",
  sources: ["web", "news"],
  maxResults: 10
}})
```

## Body Shape

| Field | Required | Type | Notes |
|---|---|---|---|
| `query` | yes | string | Natural-language search query |
| `sources` | no | string[] | Subset of `["web","x","news"]`. Default: all three. |
| `maxResults` | no | number | 1–20 per source. Default 10. |
| `fromDate` | no | string | `YYYY-MM-DD` lower bound on result date |
| `toDate` | no | string | `YYYY-MM-DD` upper bound |

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
blockrun_search({ body: { query: "Ethereum ETF approval SEC", sources: ["news","web"], maxResults: 8 } })
```

### 2. "What is X saying about Solana's latest outage?"

```ts
blockrun_search({ body: { query: "Solana outage today", sources: ["x"], maxResults: 15 } })
```

### 3. "Background on Pectra upgrade, last 90 days only"

```ts
blockrun_search({ body: {
  query: "Ethereum Pectra upgrade",
  sources: ["web","news"],
  fromDate: "2026-02-17"
}})
```

## search vs exa — Pick the Right Tool

| Use case | Tool |
|---|---|
| "What's happening *right now*?" — freshness matters | `blockrun_search` |
| "Find the canonical paper on X" — semantic relevance matters | `blockrun_exa` |
| "Pull the full text of these 5 URLs" — content fetch | `blockrun_exa` `contents` |
| "Cited answer to a question" | both work; `blockrun_exa answer` is grounded in pre-indexed corpus, `blockrun_search` searches the live web |

## Notes

- Returns AI-summarized text + a list of sources with URLs. The summary is one paragraph; sources let you drill in.
- Sources cost individually — `maxResults: 20` with all three sources can return 60 results and price proportionally.
- Date filters are strict — results outside the window are dropped, not down-ranked.

## Reference

- Endpoint: `POST /v1/search`
- Upstream: xAI Grok Live Search
