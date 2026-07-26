# Demo case selection

All cases are selected live. Never hard-code a condition ID, token ID, price,
or outcome in a presentation script.

## Case A — BTC reaches a threshold (primary)

Search open Polymarket Bitcoin markets and choose a near-dated threshold with
material 24-hour activity. It gives a clear story: current BTC spot, percentage
move required, probability trend, smart-money positioning, and live fillability.
Prefer this case for the main Stanford demo.

Reject it when the resolution source is unclear, expiry has passed, 24-hour
volume is zero, no Yes/No token is present, or the dry-run finds no book.

## Case B — macro event (fallback)

Search an open Fed/rates or inflation question with a precise resolution rule.
Use the same market-history, smart-money, and book lenses. Add live news only
when the Trading profile's `blockrun_surf` can cite a current source. Keep news
and market-implied probability separate.

## Case C — crypto up/down (short-form fallback)

Use only a window that is already live, has non-zero recent volume/trades, and
has an executable order book. Raw `polymarket/crypto-updown` results may include
pre-created future windows with zero liquidity, so never pick the first item.

## Fallback ladder

1. If the candidate is stale or thin, return to `markets/search` and rank again.
2. If a paid history source is unavailable, show the remaining evidence and
   reduce confidence; do not retry-loop.
3. If no candidate passes the gates, demonstrate a truthful `NO TRADE` decision.
   This is a stronger safety demo than forcing a weak trade.
4. If geographic eligibility is blocked, finish with the real CLOB dry-run and
   the read-only before/after state. Never alter networking to evade the block.
