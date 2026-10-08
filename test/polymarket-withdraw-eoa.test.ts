// Run with: npm test  (tsx --experimental-test-module-mocks --test)
//
// The EOA (sigType 0) withdrawal is a plain Polygon transaction: no deadline,
// so only a receipt resolves it. Pins that the signed bytes are on disk before
// the broadcast, that a retry re-broadcasts THOSE bytes instead of signing a
// second transfer, that nonce movement is never read as "dropped", and that a
// retry which resolves the earlier withdrawal ends there.
import { test, mock } from "node:test";
import assert from "node:assert/strict";

const realViem = await import("viem");
const realConstants = await import("../src/utils/polymarket/constants.js");

const DEPOSIT = "0x5d3eaa66AE01F1a907c8e0970D1D021C6Ff8EB26";
const AGENT = "0xCC8c44AD3dc2A58D841c3EB26131E49b22665EF8";
const BRIDGE = "0x2222222222222222222222222222222222222222";
const SIGNED = "0x02f8b1018203e8" as const;
const SIGNED_HASH = realViem.keccak256(SIGNED);
const OTHER_SIGNED = "0x02f8b10182aaaa" as const;
const OTHER_HASH = realViem.keccak256(OTHER_SIGNED);

let stateFile: Record<string, unknown> = {};
let saveStateThrows = false;
let receipt: { status: "success" | "reverted" } | null = null;
let waitReceipt: () => Promise<{ status: "success" | "reverted" }> = async () => ({ status: "success" });
let txKnown: boolean | "error" = false;
let pendingNonce = 7;
let writeNonce = 9;
let readerNonceCalls = 0;
let sendRawError: Error | undefined;
let bridgeCalls = 0;
const sendRawCalls: string[] = [];
let signCalls = 0;
let stateAtBroadcast: unknown;

function reset() {
  stateFile = {};
  saveStateThrows = false;
  receipt = null;
  waitReceipt = async () => ({ status: "success" });
  txKnown = false;
  pendingNonce = 7;
  writeNonce = 9;
  readerNonceCalls = 0;
  sendRawError = undefined;
  bridgeCalls = 0;
  sendRawCalls.length = 0;
  signCalls = 0;
  stateAtBroadcast = undefined;
}

class NotFound extends Error {
  constructor(name: string) { super(`${name} (test)`); this.name = name; }
}

mock.module("viem", {
  namedExports: {
    ...realViem,
    createWalletClient: () => ({
      prepareTransactionRequest: async (req: Record<string, unknown>) => ({ ...req, nonce: req.nonce ?? writeNonce }),
      signTransaction: async () => { signCalls++; return SIGNED; },
      sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: string }) => {
        stateAtBroadcast = stateFile.pendingWithdraw;
        sendRawCalls.push(serializedTransaction);
        if (sendRawError) throw sendRawError;
        return realViem.keccak256(serializedTransaction as `0x${string}`);
      },
    }),
  },
});
mock.module("../src/utils/polymarket/constants.js", {
  namedExports: { ...realConstants, getSigType: () => 0 },
});
mock.module("../src/utils/polymarket/positions.js", {
  namedExports: { getFundsAddress: () => AGENT },
});
mock.module("../src/utils/polymarket/setup.js", {
  namedExports: {
    getPublicClient: () => ({
      readContract: async ({ address }: { address: string }) =>
        address.toLowerCase() === realConstants.USDCE_COLLATERAL.toLowerCase() ? 0n : 7_500_000n,
      getTransactionCount: async () => { readerNonceCalls++; return pendingNonce; },
      getTransactionReceipt: async () => {
        if (!receipt) throw new NotFound("TransactionReceiptNotFoundError");
        return receipt;
      },
      waitForTransactionReceipt: async () => waitReceipt(),
      getTransaction: async () => {
        if (txKnown === "error") throw new Error("rpc 503 (test)");
        if (!txKnown) throw new NotFound("TransactionNotFoundError");
        return {};
      },
    }),
    getPusdBalance: async () => 7.5,
  },
});
mock.module("../src/utils/polymarket/client.js", {
  namedExports: {
    getPolymarketAccount: () => ({ address: AGENT }),
    checkGeoblock: async () => ({ orderPlacement: "permitted", country: "JP", ip: null, raw: {} }),
    getClobClient: async () => { throw new Error("not used"); },
    resetClobClient: () => {},
    getClobProxyAgent: () => null,
    installUnderscoreHeaderBridge: () => {},
  },
});
mock.module("../src/utils/polymarket/creds.js", {
  namedExports: {
    loadState: () => ({ ...stateFile }),
    saveState: (patch: Record<string, unknown>) => {
      if (saveStateThrows) throw new Error("disk full (test)");
      stateFile = { ...stateFile, ...patch };
      return stateFile;
    },
    loadDepositWalletForSigner: () => DEPOSIT,
    loadL2Creds: () => null,
    saveL2Creds: () => {},
    invalidateL2Creds: () => {},
    loadBuilderCreds: () => null,
    saveBuilderCreds: () => {},
  },
});
mock.module("../src/utils/polymarket/relayer.js", {
  namedExports: {
    sendWalletBatch: async () => { throw new Error("relayer not used on the EOA rail"); },
    getRelayerTransactionState: async () => { throw new Error("relayer not used on the EOA rail"); },
    BATCH_DEADLINE_SECS: 300,
  },
});
mock.module("axios", {
  defaultExport: {
    post: async () => { bridgeCalls++; return { data: { address: { evm: BRIDGE } } }; },
    get: async () => { throw new Error("not used"); },
  },
});

const { withdrawFunds, isDefiniteBroadcastRejection } = await import("../src/utils/polymarket/withdraw.js");

const pendingEoa = (extra: Record<string, unknown> = {}) => ({
  pendingWithdraw: {
    transactionID: `eoa:${SIGNED_HASH}`,
    deadline: Math.floor(Date.now() / 1000) - 3600, // long past: must not matter for an EOA tx
    nonce: 7,
    serializedTransaction: SIGNED,
    ...extra,
  },
});

// --- the send ---

test("the signed bytes, their hash and nonce are on disk BEFORE the broadcast", async () => {
  reset();
  pendingNonce = 3; // the public reader disagrees with the write node
  const res = await withdrawFunds({ amount_usd: 2, confirm: true });
  assert.equal(res.isError, undefined, res.text);
  assert.deepEqual(stateAtBroadcast, {
    transactionID: `eoa:${SIGNED_HASH}`,
    deadline: (stateAtBroadcast as { deadline: number }).deadline,
    nonce: 9,
    serializedTransaction: SIGNED,
  });
  assert.equal(readerNonceCalls, 0, "the nonce comes from the write endpoint, never the public reader");
  assert.deepEqual(sendRawCalls, [SIGNED]);
  assert.equal(stateFile.pendingWithdraw, undefined, "a success receipt clears the guard");
  assert.match(res.text, /Withdrawal submitted/);
});

test("a failed write of the record means nothing is broadcast", async () => {
  reset();
  saveStateThrows = true;
  const res = await withdrawFunds({ amount_usd: 2, confirm: true });
  assert.equal(res.isError, true);
  assert.equal(sendRawCalls.length, 0);
});

for (const message of ["socket hang up", "nonce too low", "already known", "HTTP request failed. Status: 502"]) {
  test(`an ambiguous broadcast error (${message}) keeps the guard and warns against a new withdrawal`, async () => {
    reset();
    sendRawError = new Error(message);
    const res = await withdrawFunds({ amount_usd: 2, confirm: true });
    assert.equal(res.isError, true);
    assert.match(res.text, /may still land/);
    assert.match(res.text, /Do NOT start a new withdrawal/);
    assert.equal((stateFile.pendingWithdraw as { transactionID?: string })?.transactionID, `eoa:${SIGNED_HASH}`);
  });
}

test("a definite node rejection the RPC does not know releases the guard", async () => {
  reset();
  sendRawError = new Error("insufficient funds for gas * price + value");
  txKnown = false;
  const res = await withdrawFunds({ amount_usd: 2, confirm: true });
  assert.equal(res.isError, true);
  assert.match(res.text, /Nothing was sent/);
  assert.equal(stateFile.pendingWithdraw, undefined);
});

test("a definite rejection keeps the guard when the RPC knows the hash, or cannot say", async () => {
  for (const known of [true, "error"] as const) {
    reset();
    sendRawError = new Error("transaction underpriced");
    txKnown = known;
    const res = await withdrawFunds({ amount_usd: 2, confirm: true });
    assert.equal(res.isError, true);
    assert.doesNotMatch(res.text, /Nothing was sent/);
    assert.ok(stateFile.pendingWithdraw, `guard kept (txKnown=${known})`);
  }
});

test("a receipt that never arrives keeps the guard", async () => {
  reset();
  waitReceipt = async () => { throw new Error("Timed out while waiting for transaction (test)"); };
  const res = await withdrawFunds({ amount_usd: 2, confirm: true });
  assert.equal(res.isError, true);
  assert.match(res.text, /may still land/);
  assert.ok(stateFile.pendingWithdraw);
});

test("isDefiniteBroadcastRejection reads nested causes and excludes the ambiguous phrases", () => {
  assert.equal(isDefiniteBroadcastRejection(new Error("outer", { cause: new Error("intrinsic gas too low") })), true);
  assert.equal(isDefiniteBroadcastRejection(new Error("nonce too low")), false);
  assert.equal(isDefiniteBroadcastRejection(new Error("already known")), false);
});

// --- the retry ---

test("no receipt: the SAME signed bytes are re-broadcast, nothing new is signed, and the call is blocked", async () => {
  reset();
  stateFile = pendingEoa();
  const res = await withdrawFunds({ amount_usd: 2, confirm: true });
  assert.equal(res.isError, true);
  assert.match(res.text, /re-broadcast as the SAME signed transaction/);
  assert.deepEqual(sendRawCalls, [SIGNED]);
  assert.equal(signCalls, 0);
  assert.equal(bridgeCalls, 0);
  assert.ok(stateFile.pendingWithdraw, "a passed deadline does not expire an EOA transaction");
});

test("an advanced nonce plus an unknown hash is NOT read as dropped", async () => {
  reset();
  stateFile = pendingEoa();
  pendingNonce = 12;
  txKnown = false;
  const res = await withdrawFunds({ amount_usd: 2, confirm: true });
  assert.equal(res.isError, true);
  assert.match(res.text, /may still land/);
  assert.equal(signCalls, 0);
  assert.ok(stateFile.pendingWithdraw);
});

for (const [status, word] of [["success", /SETTLED/], ["reverted", /REVERTED/]] as const) {
  test(`a ${status} receipt is reported and the call ends — no second withdrawal`, async () => {
    reset();
    stateFile = pendingEoa();
    receipt = { status };
    const res = await withdrawFunds({ amount_usd: 2, confirm: true });
    assert.equal(res.isError, true);
    assert.match(res.text, word);
    assert.match(res.text, /Nothing new was signed/);
    assert.equal(signCalls, 0);
    assert.equal(bridgeCalls, 0);
    assert.equal(sendRawCalls.length, 0);
    assert.equal(stateFile.pendingWithdraw, undefined);
  });
}

// --- records written by earlier versions (no signed bytes) ---

test("a legacy eoa:<hash> record the RPC still knows keeps blocking after its window", async () => {
  reset();
  stateFile = { pendingWithdraw: { transactionID: `eoa:${OTHER_HASH}`, deadline: Math.floor(Date.now() / 1000) - 3600 } };
  txKnown = true;
  const res = await withdrawFunds({ amount_usd: 2, confirm: true });
  assert.equal(res.isError, true);
  assert.match(res.text, /may still land/);
  assert.ok(stateFile.pendingWithdraw);
  assert.equal(bridgeCalls, 0);
});

test("a legacy eoa:<hash> record past its window and unknown to the RPC is reported as unproven and ends the call", async () => {
  reset();
  stateFile = { pendingWithdraw: { transactionID: `eoa:${OTHER_HASH}`, deadline: Math.floor(Date.now() / 1000) - 3600 } };
  txKnown = false;
  const res = await withdrawFunds({ amount_usd: 2, confirm: true });
  assert.equal(res.isError, true);
  assert.match(res.text, /not proven/);
  assert.match(res.text, /Nothing new was signed/);
  assert.equal(bridgeCalls, 0);
  assert.equal(stateFile.pendingWithdraw, undefined);
});
