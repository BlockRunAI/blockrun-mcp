/**
 * Shared MCP safety metadata. Keep these conservative: a tool that can spend
 * USDC or mutate external state is not read-only even when some actions are.
 */
export const TOOL_ANNOTATIONS = {
  readOnly: {
    readOnlyHint: true,
    openWorldHint: false,
    destructiveHint: false,
  },
  readOnlyOpenWorld: {
    readOnlyHint: true,
    openWorldHint: true,
    destructiveHint: false,
  },
  walletManagement: {
    readOnlyHint: false,
    openWorldHint: false,
    destructiveHint: false,
  },
  paidPrivate: {
    readOnlyHint: false,
    openWorldHint: false,
    destructiveHint: true,
  },
  paidOpenWorld: {
    readOnlyHint: false,
    openWorldHint: true,
    destructiveHint: true,
  },
  publicOrExternalWrite: {
    readOnlyHint: false,
    openWorldHint: true,
    destructiveHint: true,
  },
} as const;
