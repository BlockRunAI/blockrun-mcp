// Pins sendWalletBatch's disambiguation of `wait()` returning undefined
// (issue #72 finding 1): the SDK returns undefined for BOTH an on-chain
// failure and a poll timeout, and those need OPPOSITE advice — a failed batch
// is safe to retry, a timed-out one is NOT (its signature stays executable
// until the 300s deadline, so re-signing a withdrawal can double-send). Also
// pins the pendingWithdraw tracking lifecycle the withdraw guard depends on.
import { test, mock } from "node:test";
import assert from "node:assert/strict";

let waitResult: { transactionHash?: string } | undefined;
let txnState: string | undefined;
let getTransactionThrows = false;
let stateFile: Record<string, unknown> = {};
const saveStateCalls: Array<Record<string, unknown>> = [];

class FakeRelayClient {
  async executeDepositWalletBatch() {
    return {
      transactionID: "batch-1",
      wait: async () => waitResult,
      getTransaction: async () => [],
    };
  }
  async getTransaction() {
    if (getTransactionThrows) throw new Error("relayer 502");
    return txnState ? [{ state: txnState, transactionHash: "0x" + "cd".repeat(32) }] : [];
  }
}

mock.module("@polymarket/builder-relayer-client", {
  namedExports: { RelayClient: FakeRelayClient },
});
mock.module("../src/utils/polymarket/client.js", {
  namedExports: {
    getPolymarketAccount: () => ({ address: "0xCC8c44AD3dc2A58D841c3EB26131E49b22665EF8" }),
    checkGeoblock: async () => ({ orderPlacement: "permitted", country: "FI", ip: null, raw: {} }),
    getClobClient: async () => { throw new Error("not used"); },
    resetClobClient: () => {},
    getClobProxyAgent: () => null,
    installUnderscoreHeaderBridge: () => {},
  },
});
mock.module("../src/utils/polymarket/creds.js", {
  namedExports: {
    // Cached builder creds → getRelayClient never touches the CLOB.
    loadBuilderCreds: () => ({ key: "k", secret: "s", passphrase: "p", createdAt: "" }),
    saveBuilderCreds: () => {},
    loadL2Creds: () => null,
    saveL2Creds: () => {},
    invalidateL2Creds: () => {},
    loadDepositWalletForSigner: () => undefined,
    loadState: () => ({ ...stateFile }),
    saveState: (patch: Record<string, unknown>) => {
      saveStateCalls.push(patch);
      stateFile = { ...stateFile, ...patch };
      return stateFile;
    },
  },
});

const { sendWalletBatch } = await import("../src/utils/polymarket/relayer.js");
const DEPOSIT = "0x5d3eaa66AE01F1a907c8e0970D1D021C6Ff8EB26";
const CALLS = [{ target: DEPOSIT, value: "0", data: "0x" }] as never;

function reset() {
  waitResult = undefined;
  txnState = undefined;
  getTransactionThrows = false;
  stateFile = {};
  saveStateCalls.length = 0;
}

test("a confirmed batch returns its hash and clears tracked pending state", async () => {
  reset();
  waitResult = { transactionHash: "0x" + "ab".repeat(32) };
  const res = await sendWalletBatch(CALLS, DEPOSIT, "Withdraw", { trackPendingWithdraw: true });
  assert.equal(res.transactionHash, "0x" + "ab".repeat(32));
  // Tracked while in flight (so a crash mid-wait leaves the guard armed)…
  assert.ok(saveStateCalls.some((p) => (p.pendingWithdraw as { transactionID?: string })?.transactionID === "batch-1"));
  // …and cleared on confirmation.
  assert.equal(stateFile.pendingWithdraw, undefined);
});

test("STATE_FAILED reads as a failure — retry-safe wording, guidance included, tracking cleared", async () => {
  reset();
  txnState = "STATE_FAILED";
  await assert.rejects(
    sendWalletBatch(CALLS, DEPOSIT, "Withdraw", { trackPendingWithdraw: true, guidance: "custom guidance here" }),
    (err: Error) => {
      assert.match(err.message, /failed on-chain/);
      assert.match(err.message, /custom guidance here/);
      return true;
    },
  );
  assert.equal(stateFile.pendingWithdraw, undefined, "a dead batch must not keep blocking withdrawals");
});

test("a poll timeout with the batch still pending says DO NOT retry and keeps the guard armed", async () => {
  reset();
  txnState = "STATE_NEW";
  await assert.rejects(
    sendWalletBatch(CALLS, DEPOSIT, "Withdraw", { trackPendingWithdraw: true }),
    (err: Error) => {
      assert.match(err.message, /did not confirm within the polling window/);
      assert.match(err.message, /Do NOT retry/);
      assert.doesNotMatch(err.message, /failed/, "pending is not a failure — 'failed' would fire revert-hint regexes");
      return true;
    },
  );
  assert.ok(stateFile.pendingWithdraw, "the in-flight batch must stay tracked");
});

test("an unreachable relayer after timeout is treated as pending — the conservative side", async () => {
  reset();
  getTransactionThrows = true;
  await assert.rejects(
    sendWalletBatch(CALLS, DEPOSIT, "Redeem"),
    (err: Error) => {
      assert.match(err.message, /relayer state: unreachable/);
      assert.match(err.message, /Do NOT retry/);
      return true;
    },
  );
});
