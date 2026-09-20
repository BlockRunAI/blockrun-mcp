---
name: decide
description: "Use when the user wants to try BlockRun's free typed-judgment endpoint (POST api.blockrun.ai/v1/decide, served by OpenJev) on their own data from Claude Code — yes/no, labelled choice, or scored-rung questions over a text or JSON state, up to 64 per call. Not an MCP tool: call it with curl from the shell. Covers the request shape, what the confidence number does and does not mean, and why OpenJev is not Jev."
triggers:
  - "decide"
  - "v1/decide"
  - "typed judgment"
  - "typed judgments"
  - "openjev"
  - "open jev"
  - "jev"
  - "nli"
  - "natural language inference"
  - "entailment"
  - "classify with a small model"
  - "cheap classifier"
  - "judgment model"
  - "score these"
  - "label these"
  - "triage tickets"
---

# Decide — free typed judgments from Claude Code

`POST https://api.blockrun.ai/v1/decide` takes a **state** (a message, a ticket, a
diff, a tool result, a row of data) and up to **64 questions**, and returns a typed
answer with a number beside each one. No prose to parse. The backend is
**OpenJev**, an open-source natural-language-inference model BlockRun hosts.

It is **not a BlockRun MCP tool**, on purpose: you are already a frontier model,
and for a one-off "is this urgent?" you are the better judge. The endpoint earns
its place when the user wants the *same fixed ruler over many items*, or is
prototyping a judgment they will later run from a pipeline **without** a model.
From Claude Code, call it with `curl` from the shell.

## What it is not

- **Not paid, not x402.** It is free behind a registered API key. There is no
  payment header, no wallet path, and it is served by `api.blockrun.ai`, not the
  x402 gateway at `blockrun.ai` (a POST to `blockrun.ai/v1/decide` is a 404).
- **OpenJev is not Jev.** Jev is TypeSafe's model. OpenJev is an unaffiliated
  open-source NLI cross-encoder (MIT, published by AlexWortega on Hugging Face,
  Qwen3.5 4B base). It is not made by the people who make Jev and it is not a
  smaller or free tier of it. BlockRun does not sell or resell Jev. There is one
  backend, and the `x-blockrun-backend` response header names it on every call.
- **No quality comparison exists.** BlockRun expects OpenJev to be materially
  weaker than Jev, has not benchmarked the two, and will not put a number on the
  gap. Do not invent one. The model authors' own zero-shot NLI figures, with
  attribution and a read date, are at <https://blockrun.ai/openjev>.

## Getting a key without changing how the MCP pays

Keys are minted at <https://user.blockrun.ai/dashboard/keys> (`brk_live_…`,
shown once; registration, not a card).

For experiments, **export the key in the shell** and leave the MCP server alone:

```bash
export BLOCKRUN_API_KEY=brk_live_…
```

Do **not** write it to `~/.blockrun/.api-key` just to try `decide`. The MCP
server reads that file at startup and a present key moves **every** paid tool
from wallet mode to account billing — the same switch `BLOCKRUN_API_KEY` in the
MCP server's own config makes. That is fine if the user wants account billing
(see the `blockrun-setup` skill); it is a surprise if they only wanted a free
judgment. If the MCP is already on account billing, the same key works for both.

## Request

```bash
curl -sS -X POST https://api.blockrun.ai/v1/decide \
  -H "authorization: Bearer $BLOCKRUN_API_KEY" \
  -H "content-type: application/json" \
  -D /dev/stderr \
  -d '{
    "state": "Help! My payouts have been failing for 3 days.",
    "questions": {
      "is_urgent":   { "type": "noul",   "instructions": "Does this convey urgency?" },
      "department":  { "type": "choice", "instructions": "Which team should handle this?",
                       "criteria": { "billing": "Payments, refunds",
                                     "technical": "Bugs, outages" } },
      "frustration": { "type": "score",  "instructions": "How frustrated is the customer?",
                       "criteria": ["Calm", "Frustrated", "Very angry"] }
    }
  }'
```

`-D /dev/stderr` shows the response headers (backend, rate-limit) without mixing
them into the JSON on stdout.

| Field | Type | Required | Notes |
|---|---|---|---|
| `state` | string \| object \| array | yes | What to judge. Text and JSON both work. If a fact matters, put it in the state — the model looks nothing up. |
| `questions` | object | yes | Your own id → question. **1 to 64** per call. |
| `model` | string | no | Defaults to `openjev`, the only backend. Leave it out. |

Three question types, one operation underneath (state = premise, question =
hypothesis, answer = how strongly the premise entails it):

| Type | `criteria` | You get back |
|---|---|---|
| `noul` | none — it is true or false | one number for how strongly the state supports the claim |
| `choice` | map of label → its meaning, **2 to 255** entries | the top label, plus a share per option |
| `score` | array of rung descriptions in words, **2 to 255** | a weighted position across the rungs, plus the distribution |

`instructions` — the question itself, in plain language — is required on all three.

## Response

```json
{
  "model": "openjev",
  "answers": {
    "is_urgent":   { "type": "noul",   "noul": 0.986 },
    "department":  { "type": "choice", "choice": "billing",
                     "probabilities": { "billing": 0.71, "technical": 0.29 },
                     "confidence": 0.71 },
    "frustration": { "type": "score",  "score": 1.42,
                     "legend": { "0": "Calm", "1": "Frustrated", "2": "Very angry" },
                     "probabilities": { "0": 0.11, "1": 0.36, "2": 0.53 },
                     "confidence": 0.53 }
  }
}
```

`score` is the probability-weighted rung index (`1.42` sits between
"Frustrated" and "Very angry"); `legend` maps index → rung text.

## Read this before you build a threshold

**The `confidence` on a `choice` is not the probability the answer is correct.**

Every option is scored against the state, and the scores are then **divided by
their total** so they sum to one. That step throws away how strong the scores
were:

- three options each scoring 0.1 — the model supporting **none** of them — come
  back as `0.33 / 0.33 / 0.33`;
- two options scoring 0.9 and 0.85 — **both** strongly supported — come back as
  `0.51 / 0.49`.

Opposite situations, identical response. The number is a **share of the
agreement found** — an ordering with a margin. Wide means the model clearly
preferred one option; narrow means it did not. It says nothing about whether
*any* option fits, and nothing has been fitted against real outcomes the way a
calibrated model's probabilities are. The same applies to `score`'s
`probabilities` and `confidence`. A `noul` is the raw entailment score and is
not normalised — but it is not calibrated either.

Set thresholds by running the user's **own labelled examples** through the
endpoint and looking at where the errors land, never by reading the number as a
percentage. An agent that gates on `confidence > 0.8` as if it were accuracy
will be wrong with no error to tell it so.

## Trying it on the user's data — the shape that works

1. **Build the state** with everything the judgment needs: the message, the
   records it refers to, the policy that governs it. Fetch with `blockrun_exa`
   or `blockrun_search` first if a fact is missing; `decide` cannot look it up.
2. **Ask the independent questions together** in one call — one round trip,
   one rate-limit hit, up to 64 answers.
3. **Combine with deterministic checks** the code already has (amount, account
   age, "was a refund already issued").
4. **Route by margin.** Act automatically where the margin is wide *and* the
   checks agree; hand narrow cases to a reasoning model — `blockrun_chat` with
   a `claude-*`, `o-`series or DeepSeek model — or to a person.

A quick evaluation loop from Claude Code: put 20–50 labelled rows in a JSON
file, loop `curl` over them with `jq`, and tabulate agreement per question.
That is the only number that should decide whether the endpoint is good enough
for the user's task.

```bash
jq -c '.[]' examples.json | while read -r row; do
  state=$(jq -c '.state' <<<"$row"); want=$(jq -r '.label' <<<"$row")
  got=$(curl -sS -X POST https://api.blockrun.ai/v1/decide \
    -H "authorization: Bearer $BLOCKRUN_API_KEY" -H "content-type: application/json" \
    -d "{\"state\": $state, \"questions\": {\"q\": {\"type\": \"choice\",
         \"instructions\": \"Which team should handle this?\",
         \"criteria\": {\"billing\": \"Payments, refunds\", \"technical\": \"Bugs, outages\"}}}}" \
    | jq -r '.answers.q.choice')
  echo "$want,$got"
done | sort | uniq -c
```

## What it does not do

It does not write, summarise, or explain — there is no free-text field in the
response. It has no memory between calls. Image input exists in the model's v2
checkpoint but the endpoint does not expose it.

## Limits and errors

| Status | Meaning | What to do |
|---|---|---|
| 400 | Body did not match the schema; the response names the field | Fix the field. Common: a `choice` with `criteria` as an array, a `score` with a map, fewer than 2 criteria, more than 64 questions. |
| 401 | Missing or invalid key | `BLOCKRUN_API_KEY` is unset in this shell, or wrong. Check <https://user.blockrun.ai/dashboard/keys>. |
| 429 | Per-key hourly limit reached | Wait for the interval the response carries (`retry-after`). The limit is enforced server-side and reported in the response — read it there; do not assume a number. |

None of these cost anything; nothing here ever does.

## Related

- API reference: <https://blockrun.ai/docs/api-reference/decide>
- OpenJev, with the authors' published figures: <https://blockrun.ai/openjev>
- Account billing for the whole MCP (if the user wants the key to pay for the
  paid tools too): `blockrun-setup` skill, "API key" section.
