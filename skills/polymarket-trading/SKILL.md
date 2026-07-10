---
name: polymarket-trading
description: Use when the user wants to actually PLACE, manage, or redeem bets on Polymarket (not just read odds — that's blockrun_markets). Covers setup (deposit wallet, funding, approvals), buy/sell with confirm gating, positions, redeeming winnings, geoblock handling, and the end-to-end demo flow.
---

# Polymarket Trading (blockrun_polymarket)

Real-money trading on Polymarket's CLOB V2 (Polygon), signed locally by the
user's BlockRun wallet key. **Data discovery stays on `blockrun_markets`** —
this tool only trades.

## Mental model

- **Signer** = the BlockRun key (`~/.blockrun/.session`). Never leaves the machine.
- **Deposit wallet** = a Polygon vault contract derived from that key
  (POLY_1271). It holds the betting funds in **pUSD** and only honors the
  signer's EIP-712 signatures. Deploy/approve/redeem are **gasless** (relayer).
- **Money separation**: bets spend pUSD on Polygon; x402 API fees spend USDC on
  Base. The budget ledger does NOT cover bets — `confirm:true` + caps do.

## Golden rules for agents

1. **Never pass `confirm:true` unless the user explicitly approved that exact
   trade.** Call once WITHOUT confirm → show the dry-run preview → ask → re-call
   with `confirm:true`.
2. Per-order cap `POLYMARKET_MAX_BET_USD` (default $25) and optional session cap
   are enforced server-side; don't try to split orders to sneak past them.
3. On ANY error, read the message — it says exactly what to do next (fund,
   approve, region, re-run setup). Don't retry blindly.

## End-to-end flow

```
# 0. No Polymarket account or API keys needed — the MCP bootstraps everything
#    from the user's own wallet on first setup. (Set POLYMARKET_CLOB_HOST to a
#    permitted-region egress only if the user is in a geoblocked region.)

# 1. Provision + inspect (idempotent, safe to re-run any time)
blockrun_polymarket action:"setup"
# → deposit wallet address + funding instructions + region status

# 2. User funds the DEPOSIT WALLET with pUSD (or USDC via Polymarket bridge)

# 3. Sign the one-time gasless approval batch (after user consent)
blockrun_polymarket action:"setup" confirm:true

# 4. Find a market + token (data tool, paid data)
blockrun_markets path:"polymarket/markets" params:{...}   # → clobTokenIds, conditionId

# 5. Preview, then place
blockrun_polymarket action:"buy" token_id:"..." amount_usd:2            # dry-run
blockrun_polymarket action:"buy" token_id:"..." amount_usd:2 confirm:true  # market FOK
#   or limit: price:0.45 size:10 (GTC; order_type:"GTD" + expires_at for expiry)
#   or via condition: condition_id:"0x..." outcome:"Yes"

# 6. Manage
blockrun_polymarket action:"orders"                     # open orders
blockrun_polymarket action:"cancel" order_id:"..."      # or all:true
blockrun_polymarket action:"positions"                  # holdings + PnL + redeemable

# 7. Claim winnings after resolution (gasless)
blockrun_polymarket action:"redeem" condition_id:"0x..."             # preview
blockrun_polymarket action:"redeem" condition_id:"0x..." confirm:true
```

## Order semantics

- Prices are probabilities 0–1, auto-rounded to the market's tick grid.
- Market **buy** = `amount_usd` (dollars). Market **sell** = `size` (shares).
- Limit orders: `price` + `size`; default GTC; `post_only:true` for maker-only.
- FOK fails whole-or-nothing; FAK fills what it can. On "FOK not filled", offer
  FAK or a limit at the shown book price.

## Regions / geoblock

Opening positions is IP-geoblocked in ~35 countries (US/UK/EU = close-only;
cancel/sell/redeem still work there). `setup` reports status. A user-operated
egress can be set via `POLYMARKET_CLOB_PROXY` (Polymarket traffic only) or
`HTTPS_PROXY`. Respecting Polymarket's ToS for the user's jurisdiction is the
user's responsibility — never suggest evading restrictions.

## Troubleshooting

- "No deposit wallet configured" → run `action:"setup"`.
- "relayer API credentials are not configured" → the env vars above; or
  `POLYMARKET_SIG_TYPE=0` for EOA mode (needs POL gas + pUSD in the EOA).
- Balance/allowance errors right after funding → `setup` again (refreshes the
  CLOB's balance cache).
- 403 → region issue; see setup's region line.
- "order signer address has to be the address of the API KEY" → auto-recovered
  once (creds re-derived); if persistent, `setup`, then consider
  `POLYMARKET_SIG_TYPE=0` (upstream clob-client-v2 issue #65).
