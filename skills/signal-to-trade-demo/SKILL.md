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

1. Start with `blockrun_polymarket` `action:"setup"` without `confirm` to check
   readiness and geographic eligibility. Use `blockrun_polymarket_read` for
   positions and orders.
2. If the current egress is blocked, never call a funds-affecting action with
   `confirm:true`. Continue with live data and a dry-run order preview only.
   A Stanford/US presentation is always dry-run mode.
3. Always preview an order without `confirm` first. A real order requires the
   user's explicit approval of the exact market, outcome, amount, price/type,
   and current region eligibility.
4. Default demo notional is $1, hard cap $2. Do not split orders to bypass caps.
5. Make paid market-data calls sequentially. Do not launch them in parallel
   against one payment wallet.

## 1. Preflight

- Confirm the Trading profile exposes nine tools and no image/video/media tool:
  wallet, price, dex, markets, surf, defi, rpc, polymarket_read, polymarket.
- Check `blockrun_wallet` status and set a small API budget if needed. Report
  only chain and rounded balance; redact addresses.
- Call `blockrun_polymarket` setup without confirmation. Record only readiness,
  pUSD balance, approvals, and region result.
- Call `blockrun_polymarket_read` positions and orders to establish the before
  state.

## 2. Discover a current market

Use a dynamic search rather than a hard-coded condition or token ID:

```text
blockrun_markets {
  path: "markets/search",
  params: { q: "Bitcoin", status: "open", venue: "polymarket", limit: "20" }
}
```

Do not use `markets/listings`; the current Predexon API no longer exposes it.
Do not automatically select the first `polymarket/crypto-updown` result because
that feed can contain future placeholders with no liquidity. Rank candidates by:

- open status and a future close time;
- an unambiguous resolution source and threshold;
- non-zero 24-hour volume and trade count;
- a valid condition ID plus outcome token IDs;
- an outcome price away from 0 and 1;
- a live order preview that finds a usable book.

Resolve the selected market using `polymarket/markets/keyset` with
`condition_id`, `status:"open"`, and a small `limit`. Do not invent Gamma API
parameters such as `active`, `closed`, `order`, or `ascending`; unknown values
may be ignored silently.

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
- proposed side and maximum $1 preview, or `NO TRADE` when gates fail.

Do not describe the result as financial advice or a guaranteed “good signal.”

## 5. Preview and verify

Preview without confirmation:

```text
blockrun_polymarket {
  action: "buy",
  token_id: "<TOKEN_ID>",
  amount_usd: 1,
  order_type: "FOK"
}
```

Show the outcome, live best ask, estimated shares, max cost, and the explicit
line `DRY RUN — nothing signed or submitted`. If blocked, stop here.

If the user explicitly approves a real order and the region is permitted,
repeat the exact call with `confirm:true`, then use
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
Order: $1 <side> preview | DRY RUN / SUBMITTED
Safety: local signing, capped notional, IDs redacted
```
