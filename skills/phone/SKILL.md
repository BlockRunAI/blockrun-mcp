---
name: phone
description: Use when the user wants phone-number intelligence (lookup, carrier, line type, SIM-swap / call-forwarding fraud signals), US/CA number provisioning (rent a phone number), or outbound AI voice calls (Bland.ai under the hood — schedule, confirm, follow-up). Pay per call in USDC.
triggers:
  - "phone lookup"
  - "carrier lookup"
  - "phone number intelligence"
  - "sim swap"
  - "call forwarding"
  - "phone fraud"
  - "buy phone number"
  - "rent phone number"
  - "us phone number"
  - "ai voice call"
  - "voice call"
  - "outbound call"
  - "appointment confirmation"
  - "bland.ai"
---

# Phone & Voice

Two namespaces in one tool: **`/v1/phone/*`** for number intelligence + provisioning, **`/v1/voice/*`** for outbound AI calls. Pay per call in USDC.

Phone numbers use **E.164 format** — `+` followed by country code and subscriber digits (US: `+1` + 10 digits; UK: `+44` + 10 digits; etc.). The examples below use `<+E.164-number>` as a placeholder — the LLM should substitute the actual number from the user's request, not copy the literal placeholder.

## How to Call from MCP

```ts
const targetNumber = "<+E.164-number-from-user>"  // e.g. user said "call my doctor at 415-..."

// Lookup carrier + line type
blockrun_phone({ path: "phone/lookup", body: { phoneNumber: targetNumber } })

// Buy a 30-day US number
blockrun_phone({ path: "phone/numbers/buy", body: { country: "US", areaCode: "415" } })

// Outbound AI call (requires `from` — see below)
const r = await blockrun_phone({ path: "voice/call", body: {
  to: targetNumber,
  from: "<+E.164-number-you-own>",       // from phone/numbers/buy
  task: "Confirm appointment for Friday at 3pm with Dr. Wong.",
  voice: "june"
}})
// poll the result (free GET, no body)
blockrun_phone({ path: `voice/call/${r.call_id}` })
```

## Endpoint Catalog

### Phone intelligence + numbers (`/v1/phone/*`)

| Path | Body | Price | Effect |
|---|---|---|---|
| `phone/lookup` | `{ phoneNumber }` | $0.0120 | Carrier, line type (mobile/landline/VoIP) |
| `phone/lookup/fraud` | `{ phoneNumber }` | $0.0520 | + SIM-swap signals, call-forwarding detection |
| `phone/numbers/buy` | `{ country?: "US"\|"CA", areaCode? }` | $5.00 | 30-day lease, US or CA |
| `phone/numbers/renew` | `{ phoneNumber }` | $5.00 | Extend lease 30 days |
| `phone/numbers/list` | `{}` | $0.0030 | Your wallet-owned numbers |
| `phone/numbers/release` | `{ phoneNumber }` | free | Return to pool |

### Outbound AI calls (`/v1/voice/*`)

| Path | Method | Body | Price |
|---|---|---|---|
| `voice/call` | POST | `{ to, task, from, voice?, max_duration?, language?, first_sentence?, wait_for_greeting? }` | $0.5420 flat |
| `voice/call/{call_id}` | GET (no body) | – | free poll |

> **`from` is REQUIRED and must be a number your wallet owns.** Provision one first with `phone/numbers/buy` ($5, 30-day lease). 400 errors from `voice/call` are almost always missing `from`.

## Voice Call Body Fields

| Field | Required | Default | Notes |
|---|---|---|---|
| `to` | yes | – | Destination E.164 number |
| `task` | yes | – | What the AI should do on the call (10–4000 chars) |
| `from` | **yes** | – | Your provisioned BlockRun caller-ID number (from `phone/numbers/buy`) |
| `voice` | no | `nat` | `nat` / `josh` / `maya` / `june` / `paige` / `derek` / `florian` |
| `max_duration` | no | 5 | Minutes, 1–30 |
| `language` | no | `en-US` | Language code, BCP-47 |
| `first_sentence` | no | – | Custom opening line for the AI |
| `wait_for_greeting` | no | false | Let recipient speak first, then AI starts |

## Voice Presets

| Voice | Tone |
|---|---|
| `nat` | Neutral / professional male, default |
| `josh` | Friendly male |
| `maya` | Warm female |
| `june` | Calm professional female |
| `paige` | Energetic female |
| `derek` | Deep male |
| `florian` | European-accented male |

## Worked Examples

### 1. Triage an inbound number for fraud

```ts
blockrun_phone({ path: "phone/lookup/fraud", body: { phoneNumber: "+14155550150" } })
```
Returns carrier, line type, SIM-swap indicator, call-forwarding state. **Cost: $0.0520.**

### 2. Spin up a US number with a 415 area code

```ts
blockrun_phone({ path: "phone/numbers/buy", body: { country: "US", areaCode: "415" } })
// returns { phoneNumber: "+14155550199", expires_at: "..." }
```
Best-effort area code match. **Cost: $5.00 for 30 days.**

### 3. Confirm an appointment via AI voice call

```ts
// Step 0 (one-time): provision a number you'll use as caller ID
const { phoneNumber: myNumber } = await blockrun_phone({
  path: "phone/numbers/buy", body: { country: "US", areaCode: "415" }
})  // $5.00, 30-day lease

// Step 1: place the call (from is REQUIRED)
const r = await blockrun_phone({ path: "voice/call", body: {
  to: "+14155550100",
  from: myNumber,
  task: "Call Dr. Wong's office. Confirm the appointment for Sarah Chen on Friday May 24th at 3pm. If the time isn't available, ask for the next opening on Friday afternoon and report back.",
  voice: "june",
  max_duration: 5,
  wait_for_greeting: true
}})
// returns { call_id: "call_abc..." } — call runs async

// Poll until done
while (true) {
  const status = await blockrun_phone({ path: `voice/call/${r.call_id}` })
  if (status.status === "completed") {
    console.log(status.summary, status.transcript)
    break
  }
  await new Promise(r => setTimeout(r, 5000))
}
```
**Cost: $0.5420 flat for the call.** Status polling is free.

### 4. List your wallet's leased numbers + release one

```ts
const { numbers } = await blockrun_phone({ path: "phone/numbers/list", body: {} })
// Release the oldest
await blockrun_phone({ path: "phone/numbers/release", body: { phoneNumber: numbers[0].phoneNumber } })
```

## Best Practices

- **Always include task context the AI can act on.** "Confirm appointment" is vague; "Confirm Sarah Chen's appointment for Friday May 24 at 3pm with Dr. Wong" is actionable.
- **Use `wait_for_greeting: true`** for human-answered calls (most cases). Set to `false` for known-IVR / known-bot destinations to skip the greeting wait.
- **`max_duration` is a hard cap** — the call ends regardless of conversation state. Default 5 min covers most scripted tasks.
- **`from` matters** for trust** — using a provisioned BlockRun number you own (from `numbers/buy`) makes the call look less spammy than a random caller ID.

## When NOT to Use

- **High-volume autodialer / robocall workloads** — pricing is per-call ($0.5420 each) which doesn't amortize like wholesale telephony
- **Receiving inbound calls** — `numbers/buy` provisions a number but inbound routing is not exposed via MCP; use Bland directly
- **Two-way human-to-human calls** — this is for AI-driven outbound; for real-time human bridging, use a SIP provider

## Notes

- `phone/lookup` is cheap reconnaissance; `phone/lookup/fraud` is 5× the price but adds SIM-swap + call-forwarding signals you can't get from a basic carrier lookup
- Voice calls return immediately with a `call_id`; the call runs in the background. Always poll `voice/call/{call_id}` to get the transcript
- The poll endpoint is free — poll as often as you want, but every 5s is plenty
- Calls that fail upstream (recipient hangs up, no answer) still charge the flat $0.5420 — Bland's pricing model

## Reference

- Phone endpoints: `POST /v1/phone/*`
- Voice endpoints: `POST /v1/voice/call` and `GET /v1/voice/call/{call_id}`
- Upstream: number intelligence + provisioning is internal; voice calls are Bland.ai
