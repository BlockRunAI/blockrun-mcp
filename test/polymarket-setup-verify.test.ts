// Pins the post-approval verification introduced after 0.32.6 shipped: the
// setup response used to echo the PRE-batch approvals snapshot after signing
// the batch, so every item it had just granted still read granted:false — and
// the inverse failure (relayer claims success, chain disagrees) was invisible
// because approvalsPending was flipped to false without a single re-read.
// verifyApprovalsLanded is the one place that decides "granted" after a
// transaction, and it may only believe a fresh chain read.
import test from "node:test";
import assert from "node:assert/strict";
import { verifyApprovalsLanded, type ApprovalItem } from "../src/utils/polymarket/setup.js";

const item = (label: string, granted: boolean): ApprovalItem => ({
  label,
  token: "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB",
  spender: "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296",
  kind: "erc20",
  granted,
});

const allGranted = [item("a", true), item("b", true)];
const oneMissing = [item("a", true), item("b", false)];

test("a first read showing everything granted is believed immediately", async () => {
  let reads = 0;
  const res = await verifyApprovalsLanded(async () => {
    reads++;
    return allGranted;
  }, 3, 1);
  assert.equal(res.allGranted, true);
  assert.equal(reads, 1, "no pointless re-reads once the chain confirms");
  assert.deepEqual(res.approvals, allGranted);
});

test("RPC propagation lag is retried, and the eventual granted read wins", async () => {
  let reads = 0;
  const res = await verifyApprovalsLanded(async () => {
    reads++;
    return reads < 3 ? oneMissing : allGranted;
  }, 3, 1);
  assert.equal(res.allGranted, true);
  assert.equal(reads, 3);
});

test("a batch that never shows up on-chain is NOT granted, after exactly `attempts` reads", async () => {
  let reads = 0;
  const res = await verifyApprovalsLanded(async () => {
    reads++;
    return oneMissing;
  }, 3, 1);
  assert.equal(res.allGranted, false);
  assert.equal(reads, 3);
  assert.deepEqual(res.approvals, oneMissing, "the caller gets the freshest snapshot to report");
});

// Conservative on a short read, mirroring didRedeemAnyHeldPosition: an empty
// approvals array (truncated/garbled RPC response) can never count as granted.
test("an empty read cannot fake success", async () => {
  const res = await verifyApprovalsLanded(async () => [], 2, 1);
  assert.equal(res.allGranted, false);
});

// Every read failing means chain state is UNKNOWN — that must surface as a
// throw for the caller to report "unverified", never as a silent verdict.
test("a read that always throws propagates instead of inventing a verdict", async () => {
  let reads = 0;
  await assert.rejects(
    verifyApprovalsLanded(async () => {
      reads++;
      throw new Error("rpc down");
    }, 3, 1),
    /rpc down/,
  );
  assert.equal(reads, 3, "all attempts are used before giving up");
});

// One flaky read in the middle must not abort verification — the next
// successful read still decides.
test("a transient read failure mid-verification is retried through", async () => {
  let reads = 0;
  const res = await verifyApprovalsLanded(async () => {
    reads++;
    if (reads === 1) throw new Error("rpc hiccup");
    return allGranted;
  }, 3, 1);
  assert.equal(res.allGranted, true);
  assert.equal(reads, 2);
});
