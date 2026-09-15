// Run with: npm test  (tsx --experimental-test-module-mocks --test)
//
// scripts/polymarket-e2e-readonly.ts is the preflight an operator runs before
// a live redeem. listPositions() catches every failure and returns
// `{ text, isError: true }` with no `structured`; the script read
// `structured?.positions ?? []` and printed `positions: []` under a
// success-shaped JSON with exit 0 — so a Data-API timeout looked like an
// empty wallet, and "nothing to redeem" was the conclusion.
//
// The script is top-level await over two utils/ calls, so it is imported here
// with both mocked (no wallet, no RPC, no network) and its stdout and exit
// code are captured. The redacted-exit installer is real; process.exit is
// intercepted so the test process survives the failure path.
import { test, mock } from "node:test";
import assert from "node:assert/strict";

const WALLET = "0x" + "ab".repeat(20);

type ToolResult = { text: string; isError?: boolean; structured?: Record<string, unknown> };
let positionsResult: ToolResult;
let withdrawalResult: ToolResult;

mock.module("../src/utils/polymarket/positions.js", {
  namedExports: { listPositions: async () => positionsResult },
});
mock.module("../src/utils/polymarket/withdraw.js", {
  namedExports: { withdrawFunds: async () => withdrawalResult },
});

const logged: string[] = [];
const realLog = console.log;
const realExit = process.exit;
class Exit extends Error {
  constructor(public code: number) { super(`exit ${code}`); }
}

async function runScript(): Promise<{ out: Record<string, unknown>; exit: number }> {
  logged.length = 0;
  console.log = (s: string) => { logged.push(String(s)); };
  process.exit = ((code?: number) => { throw new Exit(code ?? 0); }) as never;
  let exit = 0;
  try {
    // A fresh module instance per case: the query string defeats the import
    // cache, and the mocks above are consulted on every evaluation.
    await import(`../scripts/polymarket-e2e-readonly.ts?case=${Date.now()}-${Math.random()}`);
  } catch (e) {
    if (!(e instanceof Exit)) throw e;
    exit = e.code;
  } finally {
    console.log = realLog;
    process.exit = realExit;
  }
  return { out: JSON.parse(logged.join("\n")) as Record<string, unknown>, exit };
}

const dryRun: ToolResult = {
  text: "dry run",
  structured: { dryRun: true, amountUsd: 12.5, pusdUsd: 10, usdceUsd: 2.5, wrapUsd: 0, toChainId: 8453 },
};

test("a positions error is printed AS an error, redacted, and the run exits 1", async () => {
  positionsResult = { text: `Could not fetch positions from Polymarket's Data-API (timeout for ${WALLET}).`, isError: true };
  withdrawalResult = dryRun;
  const { out, exit } = await runScript();
  assert.equal(exit, 1);
  assert.equal(out.ok, false);
  assert.notDeepEqual(out.positions, [], "an outage must not read as an empty wallet");
  const positions = out.positions as { error?: string };
  assert.match(positions.error ?? "", /Could not fetch positions/);
  assert.equal(JSON.stringify(out).includes(WALLET), false, "the address must not reach stdout");
  assert.match(positions.error ?? "", /<wallet>/);
});

test("a withdrawal-preview error still exits 1 even when positions loaded", async () => {
  positionsResult = { text: "ok", structured: { positions: [] } };
  withdrawalResult = { text: `Bridge did not return an address (got: ${WALLET}).`, isError: true };
  const { out, exit } = await runScript();
  assert.equal(exit, 1);
  assert.equal(out.ok, false);
  assert.deepEqual(out.positions, []);
  assert.match(String(out.withdrawalPreview), /<wallet>/);
});

test("both sides healthy: ok:true, exit 0, positions abbreviated, condition id truncated", async () => {
  positionsResult = {
    text: "ok",
    structured: {
      positions: [{ title: "Will it rain?", outcome: "Yes", size: 3, currentValue: 0.0009, redeemable: true, negativeRisk: false, conditionId: "0x" + "12".repeat(32) }],
    },
  };
  withdrawalResult = dryRun;
  const { out, exit } = await runScript();
  assert.equal(exit, 0);
  assert.equal(out.ok, true);
  const [p] = out.positions as Array<Record<string, unknown>>;
  assert.equal(p!.title, "Will it rain?");
  assert.equal(p!.condition, "0x12121212…");
  assert.deepEqual(out.withdrawalPreview, { dryRun: true, amountUsd: 12.5, pusdUsd: 10, usdceUsd: 2.5, wrapUsd: 0, toChainId: 8453 });
});

test("an empty wallet is an empty list, distinguishable from an error", async () => {
  positionsResult = { text: "No positions.", structured: { positions: [] } };
  withdrawalResult = dryRun;
  const { out, exit } = await runScript();
  assert.equal(exit, 0);
  assert.deepEqual(out.positions, []);
  assert.equal(out.ok, true);
});
