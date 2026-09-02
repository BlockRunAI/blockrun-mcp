# Human-in-the-loop payments — spend confirmation

BlockRun MCP can pause before every paid call and ask you, in your MCP client, whether to
go ahead. The server signs nothing until you approve. This document covers what the gate
does, when to use it, which clients can show the dialog, and what happens on those that
can't.

Implementation: [`src/utils/confirm-spend.ts`](../src/utils/confirm-spend.ts). Every paid
tool calls it at its budget gate, before the first network request — enforced by
[`test/confirm-spend-coverage.test.ts`](../test/confirm-spend-coverage.test.ts).

## What it does

With confirmation on, a paid tool call goes:

1. The tool validates its arguments and **estimates** the charge (the same estimate the
   budget gate reserves).
2. If the estimate is above your threshold, the server sends an MCP **elicitation** request.
   Your client renders it as a dialog:

   ```
   💸 BlockRun charge — exa · search
   Estimated: $0.0100
   Approve this spend? (USDC is debited per call.)
   To stop the charge, choose Decline — Cancel/ESC lets it proceed.

   [ ] Approve all BlockRun charges for the rest of this session (don't ask again)

                                            [ Decline ]  [ Approve ]
   ```

3. **Decline** → the tool returns *"Charge declined — nothing was generated or charged."*
   No request is sent, no payment is signed, and the budget reservation is released.
4. **Approve** → the call proceeds exactly as it would have without the gate. Tick the
   checkbox and you will not be asked again for the lifetime of this server process — in
   practice, this client session.

Free calls never prompt: `blockrun_chat mode:"free"`, crypto/FX/commodity `blockrun_price`,
`blockrun_dex`, `blockrun_models`, `blockrun_wallet`, and the free `blockrun_phone` and
`blockrun_realface` actions.

`blockrun_polymarket` is not behind this gate. Bets are real funds on Polygon, not x402
fees, and they already require an explicit `confirm:true` on every order, approval and
redemption — a per-order contract that is stronger than a session-wide dialog.

## Enable it

Two environment variables, read once at server start:

| Variable | Default | Effect |
|---|---|---|
| `BLOCKRUN_CONFIRM_SPEND` | off | `on` / `1` / `true` / `yes` turns the gate on. |
| `BLOCKRUN_CONFIRM_THRESHOLD` | `0` | Only ask for calls estimated **above** this many USD. `0` asks for every paid call. A value that isn't a plain positive number (`$0.05`, `5c`) falls back to `0`, i.e. ask for everything — it never silently disables the gate. |

Claude Code:

```bash
claude mcp remove blockrun -s user
claude mcp add blockrun -s user \
  -e BLOCKRUN_CONFIRM_SPEND=on \
  -e BLOCKRUN_CONFIRM_THRESHOLD=0.05 \
  -- npx -y @blockrun/mcp@latest
```

JSON-configured clients (Cursor, Claude Desktop, Windsurf):

```json
{
  "mcpServers": {
    "blockrun": {
      "command": "npx",
      "args": ["-y", "@blockrun/mcp@latest"],
      "env": { "BLOCKRUN_CONFIRM_SPEND": "on", "BLOCKRUN_CONFIRM_THRESHOLD": "0.05" }
    }
  }
}
```

Restart the client after changing either variable.

## When should I use this?

**Use it when a person is in the loop and the calls are not all cheap.** The dialog costs a
few seconds of attention; a `blockrun_video` render costs up to $0.32 per second and a
`blockrun_phone` number costs $5. A threshold around `0.05` skips the fractions-of-a-cent
data calls and catches everything you would actually want to see.

**Use it while you are learning what things cost.** Set the threshold to `0` for a session
and every paid call shows its estimate before it happens. Turn it back up once you trust
the agent's judgement.

**Don't rely on it for unattended agents.** An autonomous pipeline has nobody to click
Approve, and on a client that can't render the dialog the call proceeds anyway (see
below). The unattended guard is the budget: `BLOCKRUN_BUDGET_LIMIT` caps the whole
process, and `blockrun_wallet action:"delegate" agent_id:"X" agent_limit:1.00` caps each
sub-agent. Those are enforced server-side regardless of client.

**Don't stack it on a plugin that already gates spend.** If your Claude Code plugin runs a
`PreToolUse` hook that shows the cost and asks, turning this on too means two prompts per
call. Pick one — the hook is honoured on more clients; this gate works from the bare MCP
without a plugin.

**Claude Code automation:** Claude Code lets you auto-answer elicitation requests with an
[`Elicitation` hook](https://code.claude.com/docs/en/hooks#elicitation). That is the way
to keep the gate on in scripted runs while still logging each proposed charge.

## Client support

The dialog is an MCP *elicitation* (form mode). Whether you see it depends entirely on the
client. Verified against each client's own documentation on 2026-08-29:

| Client | Shows the dialog? | Notes |
|---|---|---|
| **Claude Code** | ✅ Yes | Form and URL elicitation are documented; dialogs "appear automatically when a server requests them". Auto-answer via the `Elicitation` hook. |
| **Cursor** | ✅ Yes | Elicitation is listed as **Supported** in Cursor's MCP feature table. |
| **VS Code (GitHub Copilot)** | ✅ Yes | Elicitation support landed in VS Code 1.102; URL-mode elicitation in 1.107. |
| **Claude Desktop** | ⚠️ Partial | Observed while building this feature: a form dialog renders, but confirming it reports `cancel` rather than `accept`, so the call proceeds. Only an explicit **Decline** stops the charge. |
| **OpenClaw** | ⚠️ Surface-dependent | Codex harness form elicitation is supported, but unmappable prompts are explicitly declined. On OpenClaw 2026.8.2 WebChat → Codex, this prompt returned `decline` without an actionable dialog, so paid calls stopped. Use the hard budget and OpenClaw tool approvals on that route. |
| **Windsurf** | ❌ No | Windsurf documents support for tools, resources and prompts only. |
| **Codex CLI** | ❌ Not documented | OpenAI's MCP docs list tool calling and server instructions; elicitation is not mentioned. |
| **Gemini CLI** | ❌ Not documented | Tools, resources and prompts are documented; elicitation is not. |

Sources: [Claude Code MCP docs](https://code.claude.com/docs/en/mcp) ·
[Cursor MCP docs](https://cursor.com/docs/context/mcp) ·
[VS Code 1.102](https://code.visualstudio.com/updates/v1_102) /
[1.107 release notes](https://code.visualstudio.com/updates/v1_107) ·
[OpenClaw MCP docs](https://docs.openclaw.ai/cli/mcp) /
[Codex harness runtime](https://docs.openclaw.ai/plugins/codex-harness-runtime) ·
[Windsurf MCP docs](https://docs.windsurf.com/windsurf/cascade/mcp) ·
[Codex MCP docs](https://developers.openai.com/codex/mcp) ·
[Gemini CLI MCP docs](https://geminicli.com/docs/tools/mcp-server/).
If your client has since added elicitation, please open an issue or PR and we'll update
the row.

### What happens on a client that can't ask

The gate **fails open**. The MCP handshake tells the server whether the client advertises
the `elicitation` capability:

- Client doesn't advertise it → the call proceeds with no prompt. The tool result still
  ends with the cost footer, so you see what was charged after the fact.
- Client advertises it but can't render the form (the request throws) → the call proceeds.
- Client returns `cancel` (the user hit ESC, or the client maps "OK" to cancel, as Claude
  Desktop does) → the call proceeds. **Only `decline` stops the charge.**

This is deliberate. On a client that can't ask, failing *closed* would make every paid
tool unusable, and the user would have no way to say yes. The budget caps above are the
hard stop; the dialog is the soft one.

## Limitations

- **The dialog shows the estimate, not the settled price.** For flat-priced tools they are
  the same. For token-priced video (`blockrun_video` at 1080p / 4K) the 402 quote can come
  in above the per-second estimate; the tool still re-checks the true amount against your
  budget cap before paying, and the result footer reports the actual charge, but the
  dialog is not re-shown for the difference.
- **"Approve all" is per process.** Each MCP client session spawns its own server, so the
  latch resets whenever the client restarts. There is no way to persist it — set
  `BLOCKRUN_CONFIRM_THRESHOLD` instead if you want fewer prompts permanently.
- **The threshold is read at startup.** Changing the env var needs a client restart.
- **Sub-agents share the latch.** A session-wide approval covers every call in that
  server process, including ones a delegated `agent_id` makes. Use per-agent budgets to
  bound them.

## For agents

If a spend confirmation is declined, that is the user's decision about that charge. Report
it and stop. Do not re-issue the call with different parameters, a cheaper model, or a
split into smaller requests to get under the threshold — the threshold is the user's, not
yours.
