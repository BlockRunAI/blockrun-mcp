# Security Policy

BlockRun MCP signs real-money transactions (x402 USDC payments on Base, pUSD
trading on Polygon) with a locally held key. We treat every report that could
lead to loss of funds, key exposure, or silent mis-reporting of a money
operation as the highest priority.

## Reporting a vulnerability

**Please do not open a public issue for security reports.**

Use GitHub's private vulnerability reporting: go to the repository's
**Security** tab → **Report a vulnerability** (or
<https://github.com/BlockRunAI/blockrun-mcp/security/advisories/new>).
Reports go directly and privately to the maintainers.

Include what you can of: the affected tool/action (e.g.
`blockrun_polymarket action:"withdraw"`), the version (`npm ls @blockrun/mcp`
or the `version` field in `package.json`), reproduction steps, and impact —
especially whether funds can be moved, stranded, or mis-reported.

## What to expect

- Acknowledgement within **72 hours**.
- An assessment and remediation plan within **7 days** for anything
  fund-affecting.
- Fixes ship as a patch release to npm and the MCP registry (this repo's
  publish pipeline releases both from `main`); running `npx` installations
  pick the fix up on their next cold start.
- Credit in the release notes and CHANGELOG unless you ask otherwise.

## Supported versions

Only the **latest release on npm** (`@blockrun/mcp@latest`) is supported.
The recommended install (`npx -y @blockrun/mcp@latest`) resolves to it on
every cold start, so there is no supported back-catalog to patch.

## Scope notes

- The wallet key lives in `~/.blockrun/.session` (or `BLOCKRUN_WALLET_KEY`)
  and must never leave the machine; any code path that would print, log, or
  transmit it is in scope and critical.
- Polymarket trading approvals, redeem, and withdraw paths move user funds —
  incorrect success reporting ("the transaction landed" presented as "you
  were paid") counts as a vulnerability here, not just a bug.
- The hosted gateway (blockrun.ai) and its endpoints are a separate codebase;
  reports about them are still welcome through the same channel and will be
  routed to the right place.
