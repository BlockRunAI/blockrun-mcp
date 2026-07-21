/**
 * viem resolves waitForTransactionReceipt for both successful and reverted
 * transactions. Treat a receipt as confirmation only after its status is
 * explicitly checked.
 */
export function assertTransactionSucceeded(
  receipt: { status?: string },
  description: string,
): void {
  if (receipt.status !== "success") {
    throw new Error(`${description} reverted on Polygon; no state change was applied.`);
  }
}
