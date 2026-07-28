/**
 * Serialize x402 requests made by one MCP process. Concurrent authorizations
 * from the same wallet can race at the settlement layer (especially on
 * Solana), causing one otherwise-funded call to be rejected. The queue never
 * swallows task errors and always releases the next waiter.
 *
 * SCOPE — this deliberately covers the fast paid DATA tools only: markets,
 * surf, exa, search, rpc, defi, and paid price lookups. Sub-second calls, so
 * queueing them costs nothing.
 *
 * The long-running paid tools are deliberately NOT serialized: video and music
 * take 60–180s, image and modal tens of seconds, and chat streams. Putting a
 * 5ms price lookup behind a 3-minute video render to dodge a settlement race
 * trades a rare failure for a guaranteed one. Those tools stay concurrent, so
 * the race is still reachable across a media call and a data call — the real
 * fix for that lives at the wallet/nonce layer, not here.
 *
 * The queue is process-global and every waiter blocks on the one ahead of it,
 * so a single task that never settles would wedge EVERY paid tool for the life
 * of the process with no recovery short of a restart. `QUEUE_MAX_WAIT_MS`
 * bounds that blast radius: a waiter gives up on its predecessor and proceeds.
 * Losing serialization for one call is a recoverable annoyance; a permanently
 * stuck server is not.
 */
// Read per call, not at module load, so a test (or an operator) can set it
// without caring about ESM import order.
function queueMaxWaitMs(): number {
  return Number(process.env.BLOCKRUN_PAYMENT_QUEUE_MAX_WAIT_MS) || 120_000;
}

let tail: Promise<void> = Promise.resolve();

/** Resolves when `previous` settles, or after the cap — whichever comes first. */
function waitForTurn(previous: Promise<void>): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, queueMaxWaitMs());
    // `unref` keeps a pending watchdog from holding the process open; it is
    // absent in non-Node runtimes, hence the guard.
    (timer as { unref?: () => void }).unref?.();
    previous.then(
      () => { clearTimeout(timer); resolve(); },
      () => { clearTimeout(timer); resolve(); },
    );
  });
}

export async function serializePaidRequest<T>(task: () => Promise<T>): Promise<T> {
  const previous = tail;
  let release!: () => void;
  tail = new Promise<void>((resolve) => {
    release = resolve;
  });

  await waitForTurn(previous);
  try {
    return await task();
  } finally {
    release();
  }
}
