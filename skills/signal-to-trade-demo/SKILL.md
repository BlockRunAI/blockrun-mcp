---
name: signal-to-trade-demo
description: Prepare or run a polished BlockRun trading demo that discovers a current Polymarket market, combines live price, probability history, smart-money, and liquidity evidence into a balanced signal, produces a real order dry-run, and verifies orders or positions. Use for live demos, signal-to-trade workflows, current crypto prediction markets, or when an agent must decide whether a candidate is safe and presentable before trading.
---

# Signal-to-Trade Demo

Run one reproducible chain: discover → verify → analyze → preview → inspect.
Treat signals as evidence, never as a promise of profit. Never expose a wallet,
credential, order ID, or transaction hash in presentation output.

Read [references/demo-cases.md](references/demo-cases.md) when selecting a case
or preparing a fallback.

## Hard safety contract

1. In a presentation dry-run, do not call wallet, setup, positions, orders, or
   resources. Those responses can contain wallet-derived identifiers before the
   final answer is redacted. The presenter performs account readiness privately
   before screen sharing.
2. If the current egress is blocked, never call a funds-affecting action with
   `confirm:true`. Continue with live data and a dry-run order preview only.
   A Stanford/US presentation is always dry-run mode.
3. Always preview through `blockrun_polymarket_read` `action:"preview"`. It has
   no confirmation input and cannot sign or submit an order. A real order requires the
   user's explicit approval of the exact market, outcome, amount, price/type,
   and current region eligibility.
4. Choose the smallest whole-dollar preview from $1–$5 that satisfies the live
   `min_order_size` and book depth. Never present a smaller, non-executable
   preview as valid. Do not split orders to bypass caps.
5. Make paid market-data calls sequentially. Do not launch them in parallel
   against one payment wallet.

## 1. Private operator preflight

- Confirm the Trading profile exposes nine tools and no image/video/media tool:
  wallet, price, dex, markets, surf, defi, rpc, polymarket_read, polymarket.
- Before screen sharing, the human operator may check `blockrun_wallet`, run
  setup, and inspect positions/orders. Never include those raw calls in the
  presentation conversation.
- For the live dry-run conversation, begin directly with public market
  discovery. No account state is required to preview a CLOB order.

## 2. Discover a current market

Use a dynamic search rather than a hard-coded condition or token ID:

```text
blockrun_markets {
  path: "markets/search",
  params: { q: "Bitcoin", status: "open", venue: "polymarket", limit: "20" }
}
```

`markets/search` is the discovery path for a demo — it ranks across venues in
one call. Do not automatically select the first `polymarket/crypto-updown` result because
that feed can contain future placeholders with no liquidity. Rank candidates by:

- open status and a future close time;
- an unambiguous resolution source and threshold;
- non-zero 24-hour volume and trade count;
- a valid condition ID plus outcome token IDs;
- an outcome price away from 0 and 1;
- a live order preview that finds a usable book.

Resolve the selected market using `polymarket/markets/keyset` with
`condition_id`, `status:"open"`, and a small `limit`. Do not invent Gamma-only
parameters such as `active`, `closed`, `order`, or `ascending`; the MCP rejects
those before payment. Predexon's own `search`, `sort`, `end_after`, and
`end_before` filters are supported on that endpoint.

## 3. Collect evidence sequentially

Use four independent lenses where the market supports them:

1. **Underlying:** get current BTC/USD with `blockrun_price`, then compute the
   exact percentage move required to reach the market threshold before expiry.
2. **Probability trend:** query the selected Yes token:

   ```text
   blockrun_markets {
     path: "polymarket/candlesticks/token/<TOKEN_ID>",
     params: { interval: "60", start_time: "<UNIX_SECONDS>", end_time: "<UNIX_SECONDS>" }
   }
   ```

   `interval` is integer minutes (`60`, not `1h`); `start_time` and `end_time`
   are Unix seconds.
3. **Smart money:** use a meaningful cohort:

   ```text
   blockrun_markets {
     path: "polymarket/market/<CONDITION_ID>/smart-money",
     params: { window: "30d", min_trades: "100" }
   }
   ```

   Report wallet count, net-buyer share, volume, and aggregate PnL. A high buyer
   share with negative PnL is mixed evidence, not automatically bullish.
4. **Liquidity/history:** query historical orderbooks with `token_id`,
   `start_time`, and `end_time` in Unix milliseconds. The order dry-run is the
   authoritative live fillability check.

Record the timestamp and data source for every observation. If a source fails,
label it unavailable and continue; never manufacture a value.

## 4. Build the signal

Present an evidence table with these columns:

| Source | Observation | Supports | Reliability |
|---|---|---|---|
| Spot vs threshold | Exact distance and time remaining | Yes/No/Mixed | High |
| Market trend | Probability change over a fixed window | Yes/No/Mixed | Medium |
| Smart-money cohort | Buyer share, volume, PnL | Yes/No/Mixed | Medium |
| Book/liquidity | Spread, available size, 24h activity | Executable/Thin | High |

Then state:

- one-sentence thesis;
- strongest counterevidence;
- confidence (`low`, `medium`, or `high`) with a reason;
- proposed side and the smallest executable whole-dollar preview from $1–$5,
  or `NO TRADE` when gates fail.

Do not describe the result as financial advice or a guaranteed “good signal.”

## 5. Preview and verify

Preview through the dedicated non-destructive action:

```text
blockrun_polymarket_read {
  action: "preview",
  side: "buy",
  token_id: "<TOKEN_ID>",
  amount_usd: <SMALLEST_WHOLE_DOLLAR_FROM_1_TO_5_THAT_MEETS_MIN_SIZE>,
  order_type: "FOK"
}
```

Show the outcome, live best ask, estimated shares, max cost, and the explicit
line `DRY RUN — no order signed or submitted`.

If the user explicitly approves a real order and the region is permitted,
repeat the exact economics with `blockrun_polymarket` action `buy`/`sell` and
`confirm:true`, then use
`blockrun_polymarket_read` to inspect positions and open orders. Redact all
identifiers. If a FOK does not fill, report it honestly; do not silently switch
to FAK or raise the price.

## Presentation output

End with a compact slide-ready block:

```text
LIVE SIGNAL SNAPSHOT — <UTC timestamp>
Market: <question> | Implied probability: <p>
Underlying: <spot> | Required move: <x%> | Time left: <duration>
Trend: <change> | Smart money: <buyer share + PnL caveat>
Liquidity: <spread/activity>
Verdict: <side or NO TRADE> | Confidence: <level>
Order: $<amount> <side> preview | DRY RUN / SUBMITTED
Safety: local signing, capped notional, IDs redacted
```
