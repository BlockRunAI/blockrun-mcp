/**
 * Serialize x402 requests made by one MCP process. Concurrent authorizations
 * from the same wallet can race at the settlement layer (especially on
 * Solana), causing one otherwise-funded call to be rejected. The queue never
 * swallows task errors and always releases the next waiter.
 */
let tail: Promise<void> = Promise.resolve();

export async function serializePaidRequest<T>(task: () => Promise<T>): Promise<T> {
  const previous = tail;
  let release!: () => void;
  tail = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;
  try {
    return await task();
  } finally {
    release();
  }
}
