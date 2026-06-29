// Run with: npm test  (tsx --test)
//
// Exercises confirmSpend with confirmation ENABLED. The module reads its env
// gates at import time, so we set them before the dynamic import below. Node's
// test runner runs each file in its own process, so this env doesn't leak.
process.env.BLOCKRUN_CONFIRM_SPEND = "on";
process.env.BLOCKRUN_CONFIRM_THRESHOLD = "0.05";

import { test } from "node:test";
import assert from "node:assert/strict";

const { confirmSpend, resetSpendApproval } = await import("../src/utils/confirm-spend.js");

// Minimal McpServer stand-in: only the two members confirmSpend touches.
function fakeServer(opts: { elicitation?: boolean; result?: unknown; throws?: boolean }) {
  return {
    server: {
      getClientCapabilities: () => (opts.elicitation === false ? {} : { elicitation: {} }),
      elicitInput: async () => {
        if (opts.throws) throw new Error("client has no form mode");
        return opts.result;
      },
    },
  } as never;
}

test("free call (usd <= 0) proceeds without prompting", async () => {
  resetSpendApproval();
  const r = await confirmSpend(fakeServer({ result: { action: "decline" } }), { usd: 0, label: "x" });
  assert.equal(r.ok, true);
});

test("sub-threshold call proceeds without prompting", async () => {
  resetSpendApproval();
  // 0.04 <= 0.05 threshold → never reaches elicitInput, even a decline-stub is allowed.
  const r = await confirmSpend(fakeServer({ result: { action: "decline" } }), { usd: 0.04, label: "x" });
  assert.equal(r.ok, true);
});

test("client without elicitation proceeds (fail-open)", async () => {
  resetSpendApproval();
  const r = await confirmSpend(fakeServer({ elicitation: false }), { usd: 1, label: "x" });
  assert.equal(r.ok, true);
});

test("explicit decline aborts the charge", async () => {
  resetSpendApproval();
  const r = await confirmSpend(fakeServer({ result: { action: "decline" } }), { usd: 1, label: "x" });
  assert.equal(r.ok, false);
});

test("cancel/ESC is fail-open — the charge still proceeds", async () => {
  resetSpendApproval();
  const r = await confirmSpend(fakeServer({ result: { action: "cancel" } }), { usd: 1, label: "x" });
  assert.equal(r.ok, true);
});

test("approve_all silences subsequent prompts for the session", async () => {
  resetSpendApproval();
  const first = await confirmSpend(
    fakeServer({ result: { action: "accept", content: { approve_all_session: true } } }),
    { usd: 1, label: "x" },
  );
  assert.equal(first.ok, true);
  // A server that WOULD decline is never consulted now — session auto-approved.
  const later = await confirmSpend(fakeServer({ result: { action: "decline" } }), { usd: 5, label: "y" });
  assert.equal(later.ok, true);
  resetSpendApproval();
});

test("elicitInput throwing fails open", async () => {
  resetSpendApproval();
  const r = await confirmSpend(fakeServer({ throws: true }), { usd: 1, label: "x" });
  assert.equal(r.ok, true);
});
