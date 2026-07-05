---
name: exa-research
description: Use when researching products, finding academic papers, discovering competitors, reading webpage content, or getting cited answers grounded in real web sources. Use over generic search when semantic relevance matters.
triggers:
  - "research"
  - "web research"
  - "find papers"
  - "academic papers"
  - "competitor discovery"
  - "find similar sites"
  - "exa search"
  - "cited answer"
  - "scrape webpage"
  - "neural search"
  - "semantic search"
  - "look up sources"
---

# Exa Research

Neural web search via BlockRun. Understands meaning, not keywords. Four distinct actions for different research modes.

## How to Call from MCP

As of v0.14.1 the `blockrun_exa` tool is path-based. Pass the endpoint name as `path` and the request as `body`:

```ts
blockrun_exa({ path: "search",       body: { query: "AI agent frameworks 2026", numResults: 10 } })
blockrun_exa({ path: "answer",       body: { query: "What is speculative decoding?" } })
blockrun_exa({ path: "contents",     body: { urls: ["https://example.com/a", "https://example.com/b"] } })
blockrun_exa({ path: "find-similar", body: { url: "https://arxiv.org/abs/2401.12345", numResults: 5 } })
```

## Quick Decision Table

| User wants... | Path | Body | Cost |
|--------------|------|------|------|
| Relevant URLs on a topic | `search` | `{ query, numResults?, category? }` | $0.01/call |
| Cited answer to a question | `answer` | `{ query }` | $0.01/call |
| Full text of URLs | `contents` | `{ urls: [...] }` | $0.002/URL |
| Pages like a given URL | `find-similar` | `{ url, numResults? }` | $0.01/call |
| Recent news | `search` + `category: "news"` | – | $0.01/call |
| Academic papers | `search` + `category: "research paper"` | – | $0.01/call |
| Company info | `search` + `category: "company"` | – | $0.01/call |

Valid `category` values for `search`: `"news"`, `"research paper"`, `"company"`, `"tweet"`, `"github"`, `"pdf"`.

## Python SDK Instructions

### 1. Initialize (Python SDK)

```python
from blockrun_llm import setup_agent_wallet

chain = open(os.path.expanduser("~/.blockrun/.chain")).read().strip() if os.path.exists(os.path.expanduser("~/.blockrun/.chain")) else "base"
if chain == "solana":
    from blockrun_llm import setup_agent_solana_wallet
    client = setup_agent_solana_wallet()
else:
    from blockrun_llm import setup_agent_wallet
    client = setup_agent_wallet()
```

### 2. Search — Find Relevant URLs

```python
# Basic search
result = client._request_with_payment_raw("/v1/exa/search", {
    "query": "AI agent frameworks 2025",
    "numResults": 10,
})
for r in result.get("results", []):
    print(f"{r['title']} — {r['url']}")

# Filter by category
result = client._request_with_payment_raw("/v1/exa/search", {
    "query": "transformer architecture improvements",
    "numResults": 10,
    "category": "research paper",
})

# Restrict to specific domains
result = client._request_with_payment_raw("/v1/exa/search", {
    "query": "prediction market regulation",
    "numResults": 10,
    "includeDomains": ["reuters.com", "bloomberg.com", "wsj.com"],
})
```

**Categories:** `"news"`, `"research paper"`, `"company"`, `"tweet"`, `"github"`, `"pdf"`

### 3. Answer — Cited, Grounded Response

Use when the user asks a factual question and needs reliable sources (not Claude's training data).

```python
result = client._request_with_payment_raw("/v1/exa/answer", {
    "query": "What is the current market cap of Polymarket?",
})
print(result.get("answer", ""))
for c in result.get("citations", []):
    print(f"  [{c.get('title')}] {c.get('url')}")
```

### 4. Contents — Fetch URL Text

Use when you have URLs and need their full text for LLM context (scraping without a browser).

```python
urls = [
    "https://example.com/article-1",
    "https://example.com/article-2",
]
result = client._request_with_payment_raw("/v1/exa/contents", {
    "urls": urls,
})
for item in result.get("results", []):
    print(f"=== {item['url']} ===")
    print(item.get("text", "")[:500])
```

Up to 100 URLs per call. Returns Markdown-ready text.

### 5. Similar — Find Related Pages

Use to discover competitors, related research, or sites with similar content.

```python
result = client._request_with_payment_raw("/v1/exa/find-similar", {
    "url": "https://polymarket.com",
    "numResults": 10,
})
for r in result.get("results", []):
    print(f"{r['title']} — {r['url']}")
```

## Common Research Workflows

**Competitor discovery:**
```python
# 1. Find similar companies
similar = client._request_with_payment_raw("/v1/exa/find-similar", {"url": "https://target-company.com", "numResults": 15})
urls = [r["url"] for r in similar.get("results", [])]

# 2. Fetch their about pages
contents = client._request_with_payment_raw("/v1/exa/contents", {"urls": urls[:10]})
```

**Research synthesis:**
```python
# 1. Find papers
papers = client._request_with_payment_raw("/v1/exa/search", {
    "query": "your topic",
    "category": "research paper",
    "numResults": 20,
})

# 2. Get answer with citations
answer = client._request_with_payment_raw("/v1/exa/answer", {
    "query": "What are the key findings on your topic?",
})
```

## When to Use Exa vs `client.search()`

| Use `blockrun_exa` / `_request_with_payment_raw` | Use `client.search()` |
|---------------------------------------------------|----------------------|
| Finding specific URLs and fetching content | Getting a summarized answer with citations |
| Semantic similarity search | Web + news combined |
| Academic paper discovery | Cheaper per call for simple lookups |
| Domain-filtered research | Already returns a SearchResult object |

## Requirements

- BlockRun SDK: `pip install blockrun-llm`
- USDC wallet funded (see `client.get_balance()`)
- `_request_with_payment_raw` is the Python SDK entry point for Exa (no dedicated method yet)
