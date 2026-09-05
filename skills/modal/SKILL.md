---
name: modal
description: Use when the user needs to run isolated code remotely — a disposable container, optional GPU access (T4 → H100), or a safer place for untrusted / heavy code. Prefer local execution for normal repo work; use Modal sandboxes for isolation, hardware access, or one-shot heavy compute.
triggers:
  - "modal sandbox"
  - "remote python"
  - "sandbox execution"
  - "isolated code run"
  - "gpu sandbox"
  - "h100"
  - "a100"
  - "remote container"
  - "ephemeral container"
  - "run untrusted code"
---

# Modal Sandboxes

Disposable remote containers (with optional GPU) via Modal, paid per call in USDC. No Modal account, no GPU procurement.

**Base only in wallet mode; fine on an API key.** `sol.blockrun.ai` carries the `/v1/modal/*` routes but has no Modal backend
configured, so every action — create, exec, status, terminate — answers `503`. That reads
as "the sandbox service is down" rather than "wrong chain", which is exactly the wrong
conclusion to act on: retrying will not help. The tool checks the active chain first and
says so. Switch with `blockrun_wallet action:"chain" chain:"base"`. Prices below are Base
prices and include its per-transaction fee.

## READ THIS BEFORE SETTING `timeout`

**`timeout` is the BILLED lifetime, charged upfront in full, and never refunded — not an idle timeout.** Above 300s the price switches from a flat rate to **per-hour billing for the entire duration you ask for**, whether you use it or not. Terminating early refunds nothing.

That makes `timeout` the single most expensive field in this MCP:

| what you ask for | what you pay |
|---|---|
| `{ timeout: 300 }` | **$0.0110** |
| `{ timeout: 300, gpu: "A100" }` | **$0.2010** |
| `{ timeout: 600, gpu: "A100" }` | **$0.6677** |
| `{ timeout: 86400, gpu: "H100" }` | **$192.0010** |

All four are live-verified quotes. A 24h H100 sandbox costs **$192 upfront, non-refundable**, even if your job finishes in a minute.

**So: ask for the time you need, not a safe-looking ceiling.** Need 20 minutes of H100? `timeout: 1200` is $2.67, not $192. Keep `timeout ≤ 300` and you stay on the flat rate entirely.

## How to Call from MCP

```ts
// 1. Create — timeout: 300 keeps you on the FLAT rate ($0.0110, or $0.2010 with A100).
//    Anything above 300 bills hourly for the full requested lifetime, no refund.
blockrun_modal({ path: "sandbox/create", body: {
  image: "python:3.11",
  gpu: "A100",
  timeout: 300,
  setup_commands: ["pip install torch transformers"]
}})
// returns { sandbox_id, ... }

// 2. Exec
blockrun_modal({ path: "sandbox/exec", body: {
  sandbox_id: "sb_abc...",
  command: ["python", "-c", "import torch; print(torch.cuda.get_device_name(0))"]
}})

// 3. Terminate
blockrun_modal({ path: "sandbox/terminate", body: { sandbox_id: "sb_abc..." } })
```

## Endpoint Catalog

| Path | Method | Body | Price |
|---|---|---|---|
| `sandbox/create` | POST | `{ image?, timeout?, cpu?, memory?, gpu?, setup_commands? }` | **depends on `timeout` + `gpu` — see below** |
| `sandbox/exec` | POST | `{ sandbox_id, command: ["python","-c","..."], timeout? }` | $0.0020 |
| `sandbox/status` | POST | `{ sandbox_id }` | $0.0020 |
| `sandbox/terminate` | POST | `{ sandbox_id }` | $0.0020 |

### `sandbox/create` pricing is bimodal

**`timeout ≤ 300s` — flat rate, charged once:**

| gpu | price |
|---|---|
| *(none, CPU)* | $0.0110 |
| `T4` | $0.0510 |
| `L4` | $0.0810 |
| `A10G` | $0.1010 |
| `A100` | $0.2010 |
| `H100` | $0.4010 |

**`timeout > 300s` — per-hour × the full requested lifetime, upfront, no refund:**

| gpu | per hour | 1h | 24h (max) |
|---|---|---|---|
| *(none, CPU)* | $0.10 | $0.1010 | $2.4010 |
| `T4` | $1.50 | $1.5010 | $36.0010 |
| `L4` | $2.00 | $2.0010 | $48.0010 |
| `A10G` | $2.50 | $2.5010 | $60.0010 |
| `A100` | $4.00 | $4.0010 | $96.0010 |
| `H100` | $8.00 | $8.0010 | **$192.0010** |

Hours are exact, not rounded up — `timeout: 1800` on `A100` is 0.5h = $2.0010. Every figure above includes the $0.001 flat transaction fee. Max `timeout` is 86400 (24h).

One quirk worth knowing: `timeout: 300` costs $0.0110 (flat) but `timeout: 301` costs $0.0094 (CPU-hourly) — just past the cliff is briefly *cheaper* on CPU. It stops being cheaper at 360s.

## Field Reference

| Field | Default | Notes |
|---|---|---|
| `image` | `python:3.11` | Any public Docker image. `nvidia/cuda:12-runtime` if you bring GPU code. |
| `timeout` | 300 | **BILLED lifetime in seconds — charged upfront for the full amount, never refunded.** NOT idle eviction: you pay for what you ask for, not what you use. `≤300` = flat rate; `>300` switches to per-hour billing (see the tables above). Max 86400 (24h). This is the field that turns a $0.01 sandbox into a $192 one. |
| `cpu` | 1 | CPU cores |
| `memory` | 1024 | Memory in MB |
| `gpu` | none | `T4` / `L4` / `A10G` / `A100` / `H100` — those five only. Anything else is rejected: `{"gpu":"A100-80GB"}` returns HTTP 400 *"Unsupported GPU type. Allowed: T4, L4, A10G, A100, H100"*. Drives the price hard — see the tables above. |
| `setup_commands` | `[]` | Shell commands run once during sandbox provisioning |
| `command` (exec) | required | Array form: `["python","-c","print(2+2)"]` |

## Worked Examples

### 1. Quick Python eval

```ts
const { structuredContent: sb } = await blockrun_modal({ path: "sandbox/create", body: {} })
await blockrun_modal({ path: "sandbox/exec", body: {
  sandbox_id: sb.sandbox_id,
  command: ["python", "-c", "import numpy; print(numpy.__version__)"]
}})
await blockrun_modal({ path: "sandbox/terminate", body: { sandbox_id: sb.sandbox_id } })
```
**Cost: $0.0150** — create $0.0110 + exec $0.0020 + terminate $0.0020. Every call carries the $0.001 transaction fee, so three calls pay it three times; batch your work into one `exec` rather than several.

### 2. GPU inference, A100, with deps pre-installed

```ts
blockrun_modal({ path: "sandbox/create", body: {
  image: "pytorch/pytorch:2.4.0-cuda12.1-cudnn9-runtime",
  gpu: "A100",
  timeout: 1200,
  memory: 16384,
  setup_commands: ["pip install --quiet transformers accelerate"]
}})
```
Then `sandbox/exec` with your inference command.

**Cost: $1.3383** — create $1.3343 + exec $0.0020 + terminate $0.0020. `timeout: 1200` is above the 300s flat tier, so the A100 bills hourly for the full 20 minutes you asked for: $4.00/h × (1200/3600) = $1.3333, + the $0.001 fee. It is **charged upfront and never refunded** — it does NOT auto-evict when idle, and terminating after 30 seconds still costs the full $1.3343. Ask for the time you actually need.

### 3. Test untrusted code Claude generated

```ts
blockrun_modal({ path: "sandbox/exec", body: {
  sandbox_id,
  command: ["bash", "-c", "<the generated script>"],
  timeout: 60
}})
```
Output is captured. No risk to your local machine.

## When NOT to Use Modal

- **Normal repo edits / dev work** — use local tools, Modal adds latency and cost
- **Long-running services** — sandboxes are ephemeral, not server hosts
- **Anything you'd run hundreds of times per minute** — payment overhead dominates at high QPS

## Notes

- `sandbox_id` is returned by `create` and required by every other endpoint
- `exec` is sync — blocks until command finishes or hits its `timeout`
- `terminate` is cheap; call it to free the sandbox even if `timeout` would expire shortly
- The free-tier `nvidia/*` LLM models in `blockrun_chat` are different infrastructure — Modal is for *your* arbitrary code

## Reference

- Endpoints: `POST /v1/modal/sandbox/{create,exec,status,terminate}`
- Upstream: [Modal](https://modal.com)
