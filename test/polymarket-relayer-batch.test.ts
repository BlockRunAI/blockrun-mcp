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
// When set, the submit itself throws with this message — the SDK's shape for a
// lost response is `{"error":"connection error"}`, for a rejection
// `{"error":"request error","status":4xx,...}` (http-helpers/index.js).
let submitThrows: string | undefined;
let stateFile: Record<string, unknown> = {};
const saveStateCalls: Array<Record<string, unknown>> = [];

class FakeRelayClient {
  async executeDepositWalletBatch() {
    if (submitThrows) throw new Error(submitThrows);
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
  submitThrows = undefined;
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

// --- Lost submit response (audit cluster F) ---
//
// executeDepositWalletBatch signs locally THEN posts. If the relayer accepts
// the batch but the response is lost (proxy 502/504, reset → the SDK throws
// `{"error":"connection error"}`), the signature is live for 300s yet nothing
// was persisted and the error carried no anti-retry advice — the #72.1
// double-send, still open on the submit-error side.

test("a lost submit response leaves the signed withdrawal TRACKED and says do not retry", async () => {
  reset();
  submitThrows = '{"error":"connection error"}';
  const before = Math.floor(Date.now() / 1000);
  await assert.rejects(
    sendWalletBatch(CALLS, DEPOSIT, "Withdraw", { trackPendingWithdraw: true, guidance: "custom guidance here" }),
    (err: Error) => {
      assert.match(err.message, /Do NOT retry/);
      assert.match(err.message, /may still have ACCEPTED/);
      assert.match(err.message, /connection error/, "the underlying SDK error is preserved");
      assert.match(err.message, /custom guidance here/);
      assert.doesNotMatch(err.message, /failed/, "not a revert — 'failed' would fire revert-hint regexes");
      return true;
    },
  );
  const pending = stateFile.pendingWithdraw as { transactionID: string; deadline: number } | undefined;
  assert.ok(pending, "the possibly-accepted batch must be tracked");
  assert.equal(pending.transactionID, "unknown");
  assert.ok(pending.deadline >= before + 298 && pending.deadline <= before + 302, `deadline ${pending.deadline} ≈ now+300`);
});

test("a definite 4xx rejection proves nothing was accepted — rethrown raw, guard NOT armed", async () => {
  reset();
  submitThrows = '{"error":"request error","status":400,"statusText":"Bad Request","data":{"error":"invalid signature"}}';
  await assert.rejects(
    sendWalletBatch(CALLS, DEPOSIT, "Withdraw", { trackPendingWithdraw: true }),
    (err: Error) => {
      assert.match(err.message, /invalid signature/);
      assert.doesNotMatch(err.message, /Do NOT retry/);
      return true;
    },
  );
  assert.equal(stateFile.pendingWithdraw, undefined, "a rejected batch cannot land — must not block for 5 minutes");
  assert.equal(saveStateCalls.length, 0);
});

test("an untracked batch (approvals/wrap) that loses its submit response writes no state", async () => {
  reset();
  submitThrows = '{"error":"connection error"}';
  await assert.rejects(sendWalletBatch(CALLS, DEPOSIT, "Approval batch"), /connection error/);
  assert.equal(saveStateCalls.length, 0, "only withdrawals are double-send-tracked");
  assert.equal(stateFile.pendingWithdraw, undefined);
});
