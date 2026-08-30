---
name: blockrun-upgrade
description: "Use when the BlockRun MCP server prints 'Update available', when asked to upgrade, update, or pin @blockrun/mcp, when a fix 'should be in the new version' but the client still runs the old one, when refreshing skills that were copied into a project, or when rolling back to a previous version."
triggers:
  - "update available blockrun"
  - "upgrade blockrun"
  - "update blockrun mcp"
  - "blockrun new version"
  - "still on old version"
  - "pin blockrun version"
  - "rollback blockrun"
  - "update blockrun skills"
---

# Upgrading BlockRun MCP

The server is run by `npx`, so "upgrading" means making npx fetch a newer version and
the client restart into it. Which of those two is the problem depends on how it was
installed.

## 1. Read how it was installed

```bash
claude mcp get blockrun          # registered command + args + env + scope
npm view @blockrun/mcp version   # what "latest" is on the registry right now
```

| Registered spec | What happens at each client start |
|---|---|
| `npx -y @blockrun/mcp@latest` | npx re-resolves `latest` against the registry and downloads if newer. **A client restart is the upgrade.** |
| `npx -y @blockrun/mcp` (no tag) | npx reuses whatever is in `~/.npm/_npx` — the version from the day it was installed. Restarting changes nothing. |
| `npx -y @blockrun/mcp@0.39.2` | Pinned on purpose. Only changes if you re-register. |

The startup notice is the server telling you it is not on `latest`:

```
[BlockRun] Update available: v0.39.2 → v0.42.0
[BlockRun] Run: claude mcp add blockrun -s user -- npx -y @blockrun/mcp@latest
```

## 2. Upgrade

**Registered with `@latest`:** restart the client. Done. If the notice persists, the cache
is stale or the registry was unreachable at start:

```bash
rm -rf ~/.npm/_npx          # safe — it is only a download cache
```

then restart again.

**Registered without a tag, or pinned:** re-register with `@latest`. `claude mcp add`
refuses a name that already exists, so remove first — at the scope `claude mcp get`
reported — and carry every env var and flag it printed across, one `-e` each, flags
after the package:

```bash
claude mcp remove blockrun -s user
claude mcp add blockrun -s user \
  -e PATH="$PATH" -e BLOCKRUN_KEYCHAIN=auto -e BLOCKRUN_CONFIRM_SPEND=on \
  -- npx -y @blockrun/mcp@latest --profile trading
```

Codex: `codex mcp remove blockrun` then `codex mcp add blockrun -- npx -y @blockrun/mcp@latest`.
JSON clients (Claude Desktop / Cursor / Windsurf): edit `args` to `["-y", "@blockrun/mcp@latest"]`.

Then quit and relaunch the client (Claude Code: `/mcp reconnect blockrun` respawns just
this server). A running session keeps the old process until you do.

## 3. Prove the version

```bash
npx -y @blockrun/mcp@latest --version     # what npx would launch now, e.g. 0.42.0
```

That proves what npx *would* launch. What the client *is* running is the server's
startup line on stderr — `BlockRun MCP Server started (v0.42.0) — stdio transport — 20
tools` (Claude Code: `claude --debug` or the MCP log; `/mcp` shows connection status, not
the version). If the two disagree, the client was not restarted; the stderr line wins.
No `Update available` line after it = you are current.

## 4. What can break

Read the **CHANGELOG** for the versions you are crossing:
<https://github.com/BlockRunAI/blockrun-mcp/blob/main/CHANGELOG.md>. Each entry
explains the behaviour change, not just the diff. Things that have changed across
versions and are worth checking:

- **Tool set / profiles** — `--profile` names and tool membership; a trimmed profile
  may gain or lose a tool.
- **Env-var semantics** — the kind of change to look for: `BLOCKRUN_KEYCHAIN` arrived in
  0.41; `BLOCKRUN_CONFIRM_SPEND` widened from one tool to all paid tools in 0.43. Read
  the entries for the versions *you* cross and re-check `claude mcp get blockrun` env
  against the README Configuration table.
- **Wallet file precedence** — `BLOCKRUN_WALLET_KEY` → agent `wallet.json` →
  `~/.blockrun/.session`. An upgrade never moves or rewrites the key; if a balance
  "disappears", the signer changed, not the funds. `blockrun_wallet` prints the address.
- **Polymarket approvals** — new adapter grants are added over time. After an upgrade,
  `blockrun_polymarket action:"setup" confirm:true` once before trading: idempotent and
  gasless, but it signs on-chain approvals, so say so to the user before running it.

Your USDC and keys are in `~/.blockrun/`, not in the package. Upgrading cannot lose them.

## 5. Refresh copied skills

Skills copied into a project or user directory do **not** update with the package.
Marketplace-installed skills (`/plugin marketplace add BlockRunAI/blockrun-mcp`)
refresh with `/plugin marketplace update blockrun-mcp` followed by `/reload-plugins`
(or uninstall + `/plugin install <skill>@blockrun-mcp`). For copied ones, re-run the install with `--force` — it overwrites
the files the package ships and leaves any other files in those directories alone:

```bash
ls .claude/skills ~/.claude/skills 2>/dev/null                 # where were they copied?
npx -y @blockrun/mcp@latest skills list                       # what this version ships
npx -y @blockrun/mcp@latest skills install --force            # ./.claude/skills
npx -y @blockrun/mcp@latest skills install --global --force   # ~/.claude/skills
```

`--force` replaces the shipped files. If the user edited their copies, diff before
overwriting: `skills install --to /tmp/br-skills` and `diff -r /tmp/br-skills .claude/skills`.

## Rollback

Pin the previous version and restart:

```bash
claude mcp remove blockrun -s user
claude mcp add blockrun -s user -e PATH="$PATH" -- npx -y @blockrun/mcp@0.41.1
```

Versions: <https://www.npmjs.com/package/@blockrun/mcp?activeTab=versions>. Report what
broke at <https://github.com/BlockRunAI/blockrun-mcp/issues> with the two version numbers.

## Common mistakes

| Mistake | Reality |
|---|---|
| `npm install -g @blockrun/mcp` to upgrade | The client runs `npx`, which ignores the global install. Re-register instead. |
| Editing `~/.npm/_npx/**/package.json` | It is a cache. Delete it, don't edit it. |
| Restarting only the terminal | The MCP process belongs to the client session. Restart the client (or `/mcp` reconnect in Claude Code). |
| Assuming the skills upgraded too | They are files you copied. `skills install --force`. |
