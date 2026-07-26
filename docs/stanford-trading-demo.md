# Stanford demo: live signal → Polymarket order preview

This is an 8-minute, repeatable demo for Claude Code or Codex CLI. It uses the
BlockRun `trading` profile only: nine tools, no media schemas, one local wallet,
and no vendor API keys.

## What the audience sees

1. The agent discovers a current, liquid Polymarket question.
2. It combines live BTC spot, probability history, smart-wallet positioning,
   and liquidity into one evidence table.
3. It states both the thesis and the strongest counterevidence.
4. It builds a live, executable-size CLOB order preview through the read-only
   Polymarket tool.
5. It proves nothing was signed or submitted.

At Stanford, stop at dry-run. Polymarket blocks new orders from the United
States; do not alter networking to bypass that restriction. A real-money write
test must be performed separately while physically operating from an eligible
jurisdiction and only after explicit approval of the exact trade.

## Install the isolated Trading profile

Claude Code:

```bash
claude mcp add blockrun-trading -s user \
  -e BLOCKRUN_BUDGET_LIMIT=0.15 \
  -e POLYMARKET_MAX_BET_USD=5 POLYMARKET_MAX_SESSION_USD=5 \
  -- npx -y @blockrun/mcp@latest --profile trading
claude mcp list
```

Install the demo Skill from the BlockRun marketplace:

```bash
claude plugin marketplace add BlockRunAI/blockrun-mcp
claude plugin install signal-to-trade-demo@blockrun-mcp
```

Codex CLI:

```bash
codex mcp add blockrun-trading \
  --env BLOCKRUN_BUDGET_LIMIT=0.15 \
  --env POLYMARKET_MAX_BET_USD=5 \
  --env POLYMARKET_MAX_SESSION_USD=5 \
  -- npx -y @blockrun/mcp@latest --profile trading
codex mcp list
```

Before the fixes are published, replace the `npx` command with:

```bash
node /ABSOLUTE/PATH/blockrun-mcp/dist/index.js --profile trading
```

Expected tool surface:

```text
wallet  price  dex  markets  surf  defi  rpc  polymarket_read  polymarket
```

If image, video, chat, or phone appears, the wrong profile is installed.

## Main prompt

Use the `signal-to-trade-demo` Skill and say:

```text
Use the signal-to-trade-demo Skill. Spend at most five US cents on public data.
Find one current liquid Bitcoin threshold market, build the four-source signal,
and preview the smallest executable whole-dollar FOK order from one to five US
dollars. Do not access account data or submit anything. Redact identifiers and
finish with the exact line:
DRY RUN — nothing signed or submitted.
```

For the most reliable stage pacing, use two prompts instead:

```text
Use the signal-to-trade-demo Skill. Spend at most five US cents on public data.
Find the best current liquid Bitcoin threshold market and return the four-source
signal. Do not access account data or place/preview an order.
```

```text
Preview the smallest executable whole-dollar FOK order from one to five US
dollars on the best-supported side. Use only the read-only preview action, do
not submit, and end: DRY RUN — nothing signed or submitted.
```

## Stage flow

### 0:00–1:00 — one-line product story

“BlockRun lets an agent pay for several live data sources with one self-custody
wallet, turn those sources into a traceable signal, and act on the same market
without creating API accounts.”

Show the nine-tool Trading profile. Point out that order preview lives inside
`polymarket_read`, separated from the funds-affecting trading tool, so MCP
clients do not request write approval for a dry-run.

### 1:00–3:30 — dynamic market and signal

Let the agent select a case live. The primary case is a near-dated Bitcoin
price threshold. On 2026-07-26, the tested candidate was “Will Bitcoin reach
$67,500 in July?”; reselect on presentation day instead of relying on it.

Require the agent to show:

- market probability and exact resolution source;
- current BTC price and percentage move required;
- probability change over a fixed window;
- smart-money buyer share plus aggregate PnL;
- recent volume/trades and an executable book.

### 3:30–5:30 — explain the evidence, not a magic score

The tested snapshot on 2026-07-26 showed:

| Evidence | Observation |
|---|---|
| Market | Yes about 31%; $2.03M total volume; about $37.4k and 541 trades in 24h |
| BTC spot | About $64,698; roughly 4.33% below the $67,500 trigger |
| Probability trend | About 24% → 31% over the tested 24-hour window |
| Smart-money cohort | 647 wallets; 70.48% net buyers; about $1.77M volume |
| Counterevidence | Cohort realized PnL about -$28.6k and total PnL about -$48.6k |

This is mixed evidence: positioning and probability momentum lean Yes, while
the remaining price move and negative cohort PnL argue for caution. The agent
should be allowed to return `NO TRADE`; forcing a bullish answer would make the
demo less credible.

### 5:30–7:00 — executable order preview

The agent calls `blockrun_polymarket_read` with `action:"preview"`. It chooses
the smallest whole-dollar amount from $1–$5 that clears the live minimum share
size and available book depth. The MCP shows the estimated fill and cannot sign
or submit anything.

### 7:00–8:00 — close on safety

- local signing and self-custody;
- $5 per-order and $5 per-session demo caps;
- $0.15 API budget;
- pre-payment parameter validation;
- serialized x402 calls from one wallet;
- explicit confirmation gate plus regional eligibility enforcement.

## Tested fallbacks

1. A different BTC threshold with clear Binance 1-minute-candle resolution.
2. A high-volume Fed/rates question, with cited live news kept separate from
   market-implied probability.
3. A live crypto up/down window only when activity and the order book are
   non-zero. Never select the first future placeholder from the raw feed.
4. If data is stale, liquidity is thin, or the region is blocked, finish with
   `NO TRADE` or dry-run. Do not hide the failed gate.

## Presenter checklist

- Update to the release containing these fixes; run `claude mcp list` or
  `codex mcp list`.
- Confirm wallet funding privately; never put an address on the projector.
- Run setup once before screen sharing; verify approvals and blocked-region
  status without showing identifiers.
- Keep a screenshot of the tested evidence table as a network fallback.
- Close unrelated terminals and notifications.
- Never type `confirm:true` during the Stanford session.
