// src/utils/polymarket/transactions.ts
//
// viem's waitForTransactionReceipt resolves for BOTH successful and reverted
// transactions — it only throws when the receipt cannot be fetched. So awaiting
// it proves the transaction was mined, not that it did anything. Every money
// path here must assert the status explicitly.
//
// This was open-coded in three places (redeem, setup, withdraw) with three
// slightly different error strings, and withdraw's copy was missing entirely
// until 0.32.3 — a reverted pUSD transfer printed "✅ Withdrawal submitted".
// One helper, so the next money path cannot forget.
//
// Extracted per @KillerQueen-Z's design in #66.

/** Minimal shape so callers can pass a viem receipt without importing its type. */
export interface TransactionStatusLike {
  status?: string;
}

/**
 * Throw unless the receipt says the transaction actually succeeded.
 * `description` names the operation for the error message ("Redeem transaction").
 */
export function assertTransactionSucceeded(
  receipt: TransactionStatusLike,
  description: string,
  txHash?: string,
): void {
  if (receipt.status !== "success") {
    throw new Error(
      `execution reverted: ${description}${txHash ? ` ${txHash}` : ""} reverted on-chain — no state change was applied.`,
    );
  }
}

/**
 * True when a thrown submit error PROVES the counterparty accepted nothing: a
 * 4xx, read off the CLOB SDK's ApiError `.status` property first (its message
 * is the bare error string), then off the JSON/HTTP shapes that only appear in
 * text (the relayer SDK stringifies `{"error":"request error","status":4xx}`).
 * Anything else — no status at all (socket hang up, ECONNRESET, a client-side
 * timeout) or a 5xx (a relay 502/504 after the upstream POST landed) — is
 * outcome-unknown: the signed order/batch may already be live. One answer for
 * the CLOB submit (orders.ts) and the relayer batch (relayer.ts), so the two
 * money paths cannot drift apart on the question again.
 */
export function isDefiniteRejection(err: unknown): boolean {
  const status = (err as { status?: unknown } | undefined)?.status;
  if (typeof status === "number") return status >= 400 && status < 500;
  const message = err instanceof Error ? err.message : String(err);
  return /"status":4\d\d/.test(message) || /\b(?:HTTP|status(?:\s*code)?)\s*[:=]?\s*4\d\d\b/i.test(message);
}

/** The shape every Polymarket action returns to the tool handler. */
export interface ToolResult {
  text: string;
  structured?: Record<string, unknown>;
  isError?: boolean;
}

/**
 * The human-in-the-loop gate (utils/confirm-spend.ts confirmSpend, bound to
 * the MCP server by the tool handler). `confirm:true` is a boolean the MODEL
 * supplies; with BLOCKRUN_CONFIRM_SPEND=on the operator asked for a dialog
 * before money moves, and a $0.004 rpc call got one while a $25 bet did not.
 * Called once, after every pre-sign guard has passed and before anything is
 * signed, with the notional and a label naming the action. Resolves
 * { ok:false } only on an explicit decline; off/unsupported/cancel proceed.
 */
export type SpendGate = (usd: number, label: string) => Promise<{ ok: boolean; reason?: string }>;

/**
 * The result every money path returns when the user declines at the dialog.
 * isError so the order card never renders it as "Order submitted"; the
 * "nothing was charged" wording is what the card's re-arm predicate
 * (apps/order-safety.ts) keys on to restore its pre-click state.
 */
export function declinedResult(what: string): ToolResult {
  return {
    text: `Declined at the confirmation prompt — ${what} was not signed. Nothing was signed and nothing was charged.`,
    isError: true,
    structured: { declined: true },
  };
}
