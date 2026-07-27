/**
 * Shared MCP safety metadata.
 *
 * The axis these hints describe is EFFECT, not cost. `readOnlyHint` means the
 * tool does not modify its environment; `destructiveHint` (only meaningful when
 * `readOnlyHint` is false) means an update is irreversible. Neither says
 * anything about money, and MCP has no "this costs USDC" hint.
 *
 * So a paid data query is still read-only. Marking `blockrun_markets` or
 * `blockrun_exa` destructive because it settles $0.0095 makes every client that
 * honors annotations demand approval for a plain lookup — wrong on the spec,
 * and hostile to any agent doing real research. Spend control is the budget
 * ledger's job (`BLOCKRUN_BUDGET_LIMIT`, `reserveBudget`, per-agent delegation),
 * not the safety hints'.
 *
 * What genuinely earns `destructiveHint: true` here: moving funds
 * (`polymarket`), placing real calls (`phone`), executing arbitrary code
 * (`modal`), or broadcasting a signed transaction (`rpc`).
 */
export const TOOL_ANNOTATIONS = {
  /** Local/cached reads that never leave the process boundary. */
  readOnly: {
    readOnlyHint: true,
    openWorldHint: false,
    destructiveHint: false,
  },
  /** Queries against an external API. Paid or free — reading is reading. */
  readOnlyOpenWorld: {
    readOnlyHint: true,
    openWorldHint: true,
    destructiveHint: false,
  },
  /**
   * Creates something — an image, a clip, a completion, an enrolled face asset —
   * without destroying anything. Not read-only, not destructive: the shape MCP
   * defines for a benign write.
   */
  generative: {
    readOnlyHint: false,
    openWorldHint: false,
    destructiveHint: false,
  },
  /** Local wallet/budget state changes: reversible, no external side effects. */
  walletManagement: {
    readOnlyHint: false,
    openWorldHint: false,
    destructiveHint: false,
  },
  /**
   * Moves real funds, calls real phone numbers, runs arbitrary code, or can
   * broadcast a signed transaction. Approve-before-run is correct here.
   */
  publicOrExternalWrite: {
    readOnlyHint: false,
    openWorldHint: true,
    destructiveHint: true,
  },
} as const;
