---
name: blockrun
description: |
  Pay-per-call access to AI models, real-time data, media generation and multi-chain RPC over
  x402 micropayments (USDC on Base or Solana). No API keys, no accounts, no subscriptions.
  Start here when you have the BlockRun MCP installed and need to know WHICH tool answers a
  question, how the wallet works, or how to make a first call for free.
  TOOLS: blockrun_chat, blockrun_image, blockrun_video, blockrun_music, blockrun_speech,
  blockrun_search, blockrun_exa, blockrun_markets, blockrun_polymarket_read, blockrun_polymarket,
  blockrun_surf, blockrun_price, blockrun_dex, blockrun_defi, blockrun_rpc, blockrun_phone,
  blockrun_realface, blockrun_modal, blockrun_models, blockrun_wallet.
  TRIGGERS: blockrun, x402, use grok, use gpt, use deepseek, compare models, generate image,
  generate video, generate music, text to speech, web search, news search, prediction market,
  crypto price, on-chain data, blockchain rpc, phone call, run code remotely, pay per call
homepage: https://blockrun.ai
metadata:
  version: 1
---

# BlockRun

One wallet, pay-per-call, no API keys. Every paid tool below settles in USDC over x402 at the
moment of the call.

## Never quote a price from memory

There is no price table in this skill, and that is deliberate. Every flat per-call price
published in this repo drifted by exactly the per-transaction fee the last time that fee
changed, because each one was a typed copy. Read prices from a live source instead:

| Need | Where |
|------|-------|
| Per-token model pricing | `blockrun_models` |
| What a call will actually cost | the `402` response — it carries the real amount |
| Full endpoint catalog with prices | <https://blockrun.ai/llms.txt> |

The tool descriptions in the MCP server carry current prices too; they are generated, not typed.

**Every price in these skills is the Base price.** Base and Solana are separate
gateways: Base adds a flat per-transaction fee, Solana currently adds none, so the same
call runs about $0.001 cheaper on Solana. `blockrun_defi` and `blockrun_modal` are not
served on Solana at all. Read the 402 on the chain you are actually on, and check
`blockrun_wallet action: "chain"` if a figure looks off by a tenth of a cent.

The same applies to counts. Where a number has a canonical source it is wrapped in a `br:`
HTML-comment marker in this file, regenerated from `brand-numbers.json` by
`scripts/sync-brand-numbers.mjs` and enforced in CI by `--check`. Add the marker rather than the
digits — an unmarked number is invisible to that check, which is exactly how the prices drifted.

## Getting a first call working

**Free, no wallet, no key.** <!-- br:models.free -->6<!-- /br:models.free --> open-weight
chat models cost nothing. Use `blockrun_chat` with `mode: "free"` — the parameter is `mode`,
not `routing`, and an unrecognised key is silently dropped, which lands you on the paid
`balanced` tier instead. Calling the HTTP API directly, a free model needs no wallet and no
`X-PAYMENT` header at all; it returns `200` on the first request rather than a `402`.

Do this first whenever a language model is all the task needs — it is the shortest path to
something working, and it costs nothing if it turns out to be the wrong approach.

**When you need the paid catalog**, check the balance with `blockrun_wallet`
(`action: "status"`). If it is zero:

1. `blockrun_wallet action: "setup"` prints the address and a funding QR.
2. To fund with a card, `blockrun_wallet action: "deposit"` mints a one-time Coinbase Onramp
   link and opens it. The call itself is free. Base only — on Solana it returns address and QR
   guidance instead, so fund Solana by transfer.
3. Or send USDC to the address on Base or Solana.

Do not fund a wallet inside an ephemeral sandbox (Claude Cowork / Desktop / Web). The key lives
in `~/.blockrun/` on whatever filesystem you are on, and if that is a throwaway VM the USDC goes
with it. In a sandbox, use the free models or hand the user the command to run locally.

Deeper wallet, budget and x402 mechanics — including calling the HTTP API directly — are in
[rules/wallet-and-payment.md](rules/wallet-and-payment.md).

## Which tool

| The question | Tool | Notes |
|---|---|---|
| Anything a language model can answer | `blockrun_chat` | See routing modes below |
| Make an image | `blockrun_image` | Also `/edit` for changes to an existing image |
| Make a video | `blockrun_video` | Async — submit, then poll |
| Video of one *specific* real person | `blockrun_realface` | Enroll a face, then pass `real_face_asset_id` to `blockrun_video` |
| Make music | `blockrun_music` | Full-length tracks |
| Speak text aloud | `blockrun_speech` | Also sound effects |
| "What just happened" — news, live web | `blockrun_search` | Freshest; priced per source |
| Research, papers, competitors, page contents | `blockrun_exa` | Semantic, not keyword |
| Event odds, betting markets | `blockrun_markets` | Reading only |
| Polymarket positions, open orders, order preview | `blockrun_polymarket_read` | Reads and previews only — structurally cannot sign |
| Actually place a Polymarket bet | `blockrun_polymarket` | Real money — confirm-gated. Setup and funds-affecting actions only |
| Token / FX / commodity price | `blockrun_price` | Crypto, FX and commodities are free |
| DEX pairs and liquidity | `blockrun_dex` | Free |
| DeFi TVL, yields | `blockrun_defi` | |
| On-chain SQL, wallet labels, social mindshare | `blockrun_surf` | The deep crypto tool |
| Raw JSON-RPC against a chain | `blockrun_rpc` | <!-- br:chains.rpc -->40<!-- /br:chains.rpc --> chains, one gateway |
| Phone lookup, buy a number, make an AI call | `blockrun_phone` | Buy the number first |
| Run code in a remote container / on a GPU | `blockrun_modal` | Prefer local for normal repo work |
| Which models exist, and what they cost | `blockrun_models` | |
| Balance, funding, spend caps | `blockrun_wallet` | |

The crypto tools overlap heavily. Prefer the free ones (`blockrun_price`, `blockrun_dex`) when
they already answer the question, and reach for `blockrun_surf` only when they do not.

## Picking a chat model

`blockrun_chat` takes a `mode` instead of a model id. **Default to `balanced`** — it is what an
omitted `mode` resolves to anyway, and it is the right answer for most requests.

| `mode` | Reach for it when | Speed |
|--------|-------------------|-------|
| `balanced` | **The default.** General work, code, analysis | Medium |
| `fast` | Latency matters more than depth — classification, extraction, short replies | Fastest |
| `powerful` | Frontier models. Hard reasoning, work you would not want to redo | Slowest |
| `reasoning` | Multi-step logic, maths, proofs | Slow |
| `coding` | Code generation and refactors specifically | Medium |
| `glm` | Cheap and strong at code | Fast |
| `cheap` | High volume, low stakes | Fast |
| `free` | Anything where "good enough and free" wins | Fast |

Two things to know about `free`: it routes to the open-weight tier only, and that path caps very
long inputs. Through the MCP the truncation is reported — the response carries a note saying
roughly what fraction of the prompt never reached the model — but a direct HTTP call gets no
such warning, so do not send a large document over the free tier and assume the answer covered
all of it. `mode` is ignored entirely when you pass an explicit `model`.

Name a specific model only when the user names one, or when a task genuinely needs that model's
quirk. Otherwise a mode is both cheaper and more robust to the catalog moving.

For media, the picking advice lives with the generation tools, and **`blockrun_models` is
authoritative** — this list would go stale within a release.

## Cost discipline

- **Failed requests are not charged.** Settlement happens on success only, so a non-2xx costs
  nothing and retrying after an upstream error is free. Do not let a failure stop you retrying.
- **Check the balance before an expensive call.** Video generation is the priciest category by
  a wide margin — a single call can cost more than a thousand chat calls.
- **Free before paid.** `blockrun_price` (crypto/FX/commodities), `blockrun_dex`, and the free
  chat tier cost nothing. Reach for them before their paid equivalents.
- **Set a cap for unattended work.** `blockrun_wallet action: "budget"` sets a session spend
  ceiling; `action: "delegate"` gives a sub-agent its own allowance.

## Troubleshooting

| Symptom | What it means |
|---|---|
| `402 Payment Required` came back twice | The signature did not verify. Check the wallet has a key and the chain matches the requirements. |
| "Insufficient balance" | `blockrun_wallet action: "status"`, then fund — or switch to a free model. |
| Balance funded but still zero | Wait for network confirmation and re-check; Base finality is seconds, not instant. |
| A model id 404s | It was delisted. `blockrun_models` for the live list; some ids redirect, some are gone. |
| Video job never finishes | Video is async by design. Poll the job id; minutes, not seconds. |
| Price does not match what you expected | Read the 402, not a remembered figure. Prices move. |
| Per-call cap refused to sign | That is a client-side spending hook, not BlockRun rejecting the call. |

## Related skills

Install from the same marketplace for depth on one area: `search`, `exa-research`,
`crypto-data`, `surf`, `rpc`, `prediction-markets`, `polymarket-trading`, `image-prompting`,
`phone`, `modal`.

```bash
/plugin marketplace add BlockRunAI/blockrun-mcp
```
