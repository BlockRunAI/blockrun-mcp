// Run with: npm test  (tsx --test)
//
// BLOCKRUN_BUDGET_LIMIT is sold as the hard stop on every client — including
// the ones with no spend dialog, where it is the ONLY guard. parseBudgetLimitEnv
// maps anything that is not a finite positive number to null, and null means
// UNLIMITED. That contract is shared with BLOCKRUN_CONFIRM_THRESHOLD and stays;
// what must not stay is the silence. An operator who writes "5,00", "5 USD",
// "0" or "-3" gets an unlimited server that looks capped.
//
// The fix is a single stderr line at startup (stderr is the MCP stdio log
// channel; stdout is the protocol). It fires exactly when the env is set to
// something non-empty that parses to null, names the raw value, says the cap
// is OFF, and shows how to write it. It must NOT fire for a valid cap or for
// an unset/blank env — that is the default, not a misconfiguration.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { initializeMcpServer } from "../src/mcp-handler.js";

// Same fake as apps.test.ts: registration is captured, nothing runs.
function init(env: NodeJS.ProcessEnv): string[] {
  const fake = {
    registerTool() {},
    registerResource() {},
  } as unknown as McpServer;
  const spy = mock.method(console, "error", () => {});
  try {
    initializeMcpServer(fake, { argv: ["--profile", "chat"], env });
    return spy.mock.calls.map((c) => c.arguments.map(String).join(" "));
  } finally {
    spy.mock.restore();
  }
}

const budgetLines = (lines: string[]) => lines.filter((l) => l.includes("BLOCKRUN_BUDGET_LIMIT"));

for (const raw of ["5,00", "5 USD", "5$", "0", "-3", "abc", "NaN", "Infinity"]) {
  test(`BLOCKRUN_BUDGET_LIMIT=${JSON.stringify(raw)} warns once that the cap is OFF and names the value`, () => {
    const lines = budgetLines(init({ BLOCKRUN_BUDGET_LIMIT: raw }));
    assert.equal(lines.length, 1, `expected exactly one warning, got: ${JSON.stringify(lines)}`);
    const line = lines[0];
    assert.match(line, /^\[BlockRun\] /, "startup lines carry the [BlockRun] prefix");
    assert.ok(line.includes(`BLOCKRUN_BUDGET_LIMIT="${raw}"`), `the raw value is quoted back: ${line}`);
    assert.match(line, /\bOFF\b/, "says the cap is OFF, not 'invalid'");
    assert.match(line, /unlimited/i, "spells out what OFF means for the ledger");
    assert.match(line, /BLOCKRUN_BUDGET_LIMIT=5\b/, "shows a correct spelling to copy");
    assert.match(line, /\$2\.50/, "and that a leading $ is accepted");
  });
}

for (const raw of ["5", "5.00", "$2.50", "  10 ", "0.001"]) {
  test(`BLOCKRUN_BUDGET_LIMIT=${JSON.stringify(raw)} is a valid cap and stays silent`, () => {
    assert.deepEqual(budgetLines(init({ BLOCKRUN_BUDGET_LIMIT: raw })), []);
  });
}

test("an unset or blank BLOCKRUN_BUDGET_LIMIT is the default, not a misconfiguration — no warning", () => {
  assert.deepEqual(budgetLines(init({})), []);
  assert.deepEqual(budgetLines(init({ BLOCKRUN_BUDGET_LIMIT: "" })), []);
  assert.deepEqual(budgetLines(init({ BLOCKRUN_BUDGET_LIMIT: "   " })), []);
});

test("the warning does not read process.env when an explicit env is passed", () => {
  // initializeMcpServer takes the env it is given; a test (or a host) that
  // passes {} must not be judged on the developer's shell.
  const saved = process.env.BLOCKRUN_BUDGET_LIMIT;
  process.env.BLOCKRUN_BUDGET_LIMIT = "junk";
  try {
    assert.deepEqual(budgetLines(init({})), []);
  } finally {
    if (saved === undefined) delete process.env.BLOCKRUN_BUDGET_LIMIT;
    else process.env.BLOCKRUN_BUDGET_LIMIT = saved;
  }
});
