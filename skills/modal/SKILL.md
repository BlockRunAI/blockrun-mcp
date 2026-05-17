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

Disposable remote containers (with optional GPU) via Modal, paid per call in USDC. No Modal account, no GPU procurement — pay only for what runs.

## How to Call from MCP

```ts
// 1. Create
blockrun_modal({ path: "sandbox/create", body: {
  image: "python:3.11",
  gpu: "A100",
  timeout: 600,
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
| `sandbox/create` | POST | `{ image?, timeout?, cpu?, memory?, gpu?, setup_commands? }` | $0.01 |
| `sandbox/exec` | POST | `{ sandbox_id, command: ["python","-c","..."], timeout? }` | $0.001 |
| `sandbox/status` | POST | `{ sandbox_id }` | $0.001 |
| `sandbox/terminate` | POST | `{ sandbox_id }` | $0.001 |

## Field Reference

| Field | Default | Notes |
|---|---|---|
| `image` | `python:3.11` | Any public Docker image. `nvidia/cuda:12-runtime` if you bring GPU code. |
| `timeout` | 300 | Sandbox lifetime in seconds (idle eviction) |
| `cpu` | 1 | CPU cores |
| `memory` | 1024 | Memory in MB |
| `gpu` | none | `T4` / `L4` / `A10G` / `A100` / `A100-80GB` / `H100` |
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
**Cost: $0.012** ($0.01 + $0.001 + $0.001).

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
Then `sandbox/exec` with your inference command. Sandbox auto-evicts after 1200s idle.

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
