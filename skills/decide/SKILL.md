---
name: decide
description: "Use when the user wants typed judgments over their own data from Claude Code — yes/no probabilities, a labelled choice, or a rubric score over text or images, many items at a time. BlockRun's Decisions endpoint (OpenAI Decisions-compatible, gpt-6-luna): free with a key at POST api.blockrun.ai/v1/decisions, or paid per call over x402 at blockrun.ai/api/v1/decisions. Not an MCP tool: call it with curl. Replaces the OpenJev-backed /v1/decide, which is retired."
triggers:
  - "decide"
  - "decisions"
  - "v1/decide"
  - "v1/decisions"
  - "decisions api"
  - "typed judgment"
  - "typed judgments"
  - "openjev"
  - "gpt-6-luna"
  - "classify with a small model"
  - "cheap classifier"
  - "judgment model"
  - "score these"
  - "label these"
  - "triage tickets"
---

# Decisions — typed judgments from Claude Code

`POST https://api.blockrun.ai/v1/decisions` takes an **input** (a message, a ticket,
a diff, a tool result, an image) and a list of **questions** with a fixed answer
space, and returns one typed answer per question — no prose to parse. It is
compatible with OpenAI's Decisions API and served by `gpt-6-luna`.

It is **not a BlockRun MCP tool**, on purpose: you are already a frontier model,
and for a one-off "is this urgent?" you are the better judge. The endpoint earns
its place when the user wants the *same fixed ruler over many items*, or is
prototyping a judgment they will later run from a pipeline **without** a model.
From Claude Code, call it with `curl` from the shell.

## Two rails

| Rail | Endpoint | Auth | Price |
|---|---|---|---|
| Free | `https://api.blockrun.ai/v1/decisions` | `Authorization: Bearer brk_live_…` | Free, per-key hourly limit |
| Paid | `https://blockrun.ai/api/v1/decisions` | x402 payment | Input tokens at $0.10 per 1M, at least $0.001 a call, plus the $0.001 fee. Output is not billed |

On the paid rail almost every call is $0.002 in total. Batch the questions: many
questions in one call cost the same as one. For trying it out from Claude Code,
the free rail is the right default.

**OpenJev is retired** (2026-10-07). The old `POST api.blockrun.ai/v1/decide`
shape (`state`, `noul`/`choice`/`score` with `criteria`) is still accepted and
answered by the same model, but write new calls against `/v1/decisions`.

## Getting a key without changing how the MCP pays

Keys are minted at <https://user.blockrun.ai/dashboard/keys> (`brk_live_…`,
shown once; registration, not a card).

For experiments, **export the key in the shell** and leave the MCP server alone:

```bash
export BLOCKRUN_API_KEY=brk_live_…
```

Do **not** write it to `~/.blockrun/.api-key` just to try this. The MCP server
reads that file at startup and a present key moves **every** paid tool from
wallet mode to account billing — the same switch `BLOCKRUN_API_KEY` in the MCP
server's own config makes. That is fine if the user wants account billing (see
the `blockrun-setup` skill); it is a surprise if they only wanted a free
judgment. If the MCP is already on account billing, the same key works for both.

## Request

```bash
curl -sS https://api.blockrun.ai/v1/decisions \
  -H "authorization: Bearer $BLOCKRUN_API_KEY" \
  -H "content-type: application/json" \
  -D /dev/stderr \
  -d '{
    "model": "gpt-6-luna",
    "input": "Help! My payouts have been failing for 3 days.",
    "questions": [
      { "type": "predicate", "name": "is_urgent",
        "instructions": "Does the message convey urgency?" },
      { "type": "choice", "name": "department",
        "instructions": "Which team should handle this?",
        "choices": [ { "value": "billing",   "description": "Payments, payouts, refunds" },
                     { "value": "technical", "description": "Bugs and outages" } ] },
      { "type": "score", "name": "frustration",
        "instructions": "How frustrated is the customer?",
        "levels": [ { "label": "calm",       "description": "Neutral tone" },
                    { "label": "frustrated", "description": "Clearly unhappy" },
                    { "label": "angry",      "description": "Hostile or threatening to leave" } ] }
    ]
  }'
```

`-D /dev/stderr` shows the response headers (rate limit) without mixing them
into the JSON on stdout.

| Field | Type | Required | Notes |
|---|---|---|---|
| `model` | string | no | `gpt-6-luna`, the only Decisions model. |
| `input` | string \| array | yes | A string, or messages whose `content` holds text and inline base64 images (no hosted URLs). If a fact matters, put it in — the model looks nothing up. |
| `questions` | array | yes | Each `{ type, name, instructions }`, plus `choices` or `levels`. |

| Type | You add | You get back |
|---|---|---|
| `predicate` | nothing | `probability` 0–1 |
| `choice` | `choices: [{ value, description }]` | `choice`, `probabilities` per value, `confidence` |
| `score` | `levels: [{ label, description }]`, lowest first | `score` (weighted level index from 0), `probabilities` per level, `confidence` |

A question the model declines comes back as `type: "refusal"`.

## Response (measured 2026-10-07 for the request above)

```json
{
  "model": "gpt-6-luna",
  "answers": [
    { "type": "predicate", "name": "is_urgent", "probability": 0.95 },
    { "type": "choice", "name": "department", "choice": "billing",
      "probabilities": [ { "value": "billing", "probability": 1.0 },
                         { "value": "technical", "probability": 0.0 } ],
      "confidence": 1.0 },
    { "type": "score", "name": "frustration", "score": 0.94,
      "probabilities": [ { "value": 0, "label": "calm", "probability": 0.06 },
                         { "value": 1, "label": "frustrated", "probability": 0.94 },
                         { "value": 2, "label": "angry", "probability": 0.0 } ],
      "confidence": 0.91 }
  ],
  "usage": { "input_tokens": 399, "output_tokens": 0, "total_tokens": 399 }
}
```

## Before you build a threshold

Set thresholds by running the user's **own labelled examples** through the
endpoint and looking at where the errors land — not by reading a number as an
accuracy. An agent that gates on `confidence > 0.8` without that check will be
wrong with no error to tell it so.

The model judges only the input. A question whose answer is not in it ("does
this need a reply today?" over a message that says nothing about timing) still
gets an answer that looks like a verdict. That one is policy — answer it in code.

## Trying it on the user's data — the shape that works

1. **Build the input** with everything the judgment needs. Fetch with
   `blockrun_exa` or `blockrun_search` first if a fact is missing.
2. **Ask the independent questions together** in one call.
3. **Combine with deterministic checks** the code already has.
4. **Route by margin.** Act automatically where the margin is wide *and* the
   checks agree; hand narrow cases to a reasoning model via `blockrun_chat`, or
   to a person.

A quick evaluation loop: put 20–50 labelled rows in a JSON file, loop `curl`
over them with `jq`, and tabulate agreement.

```bash
jq -c '.[]' examples.json | while read -r row; do
  input=$(jq -c '.input' <<<"$row"); want=$(jq -r '.label' <<<"$row")
  got=$(curl -sS https://api.blockrun.ai/v1/decisions \
    -H "authorization: Bearer $BLOCKRUN_API_KEY" -H "content-type: application/json" \
    -d "{\"model\": \"gpt-6-luna\", \"input\": $input, \"questions\": [{\"type\": \"choice\",
         \"name\": \"q\", \"instructions\": \"Which team should handle this?\",
         \"choices\": [{\"value\": \"billing\", \"description\": \"Payments, refunds\"},
                       {\"value\": \"technical\", \"description\": \"Bugs, outages\"}]}]}" \
    | jq -r '.answers[0].choice')
  echo "$want,$got"
done | sort | uniq -c
```

## Limits and errors

| Status | Meaning | Charged? |
|---|---|---|
| 400 | Body did not match the schema; the error names the field | No |
| 401 | Free rail: missing or invalid key | No |
| 402 | Paid rail: payment required or not verified | No |
| 429 | Free rail: per-key hourly limit; wait for `retry-after` | No |
| 502 / 504 | Model unreachable or timed out | No |

## Related

- API reference: <https://blockrun.ai/docs/api-reference/decisions>
- Account billing for the whole MCP: `blockrun-setup` skill, "API key" section.
