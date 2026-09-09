// Run with: npm test  (tsx --experimental-test-module-mocks --test)
//
// Surf (asksurf.ai) was retired upstream on 2026-09-06. Every /v1/surf/* path
// now answers HTTP 410 {"code":"endpoint_retired"} on blockrun.ai and 404 on
// sol.blockrun.ai — there is no 402, so no payment can ever be made. Verified
// live 2026-09-08 with an unauthenticated GET (a 410 is free).
//
// What went wrong before this test existed: the tool still reserved budget,
// still asked the user to approve a $0.0095 charge under BLOCKRUN_CONFIRM_SPEND,
// then let the SDK throw `API error: 410 — API request failed`. The gateway's
// retirement reason, date and alternatives never reached the user because
// @blockrun/llm's sanitizer keeps `body.error` only when it is a string, and
// the gateway nests it. So the notice has to be built here, and it has to be
// said BEFORE reserveBudget/confirmSpend — the same precedent as
// price.ts's equityNotServedMessage.
//
// Same harness as confirm-spend-coverage.test.ts: the wallet and http layers
// are mocked to throw on any use, so a reservation, a dialog, or a request
// would each be a hard failure here rather than a silent $0.0095 ask.
process.env.BLOCKRUN_CONFIRM_SPEND = "on";
process.env.BLOCKRUN_CONFIRM_THRESHOLD = "0";

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import type { BudgetState } from "../src/types.js";

let networkCalls = 0;
const boom = () => { networkCalls++; throw new Error("UNEXPECTED_NETWORK_CALL"); };
const trap = new Proxy({}, { get: () => boom });

mock.module("../src/utils/wallet.js", {
  namedExports: {
    getApiBase: () => "https://blockrun.ai/api",
    resolveGatewayUrl: (u: string) => u,
    getChain: () => "base",
    getClient: () => trap,
    buildClient: () => trap,
    buildClientWithTimeout: () => trap,
    getPriceClient: () => trap,
    getAnthropicClient: () => trap,
    baseOnlyMessage: () => null,
    getOrCreateWalletKey: () => "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    getWalletInfo: async () => ({ address: "0xTEST" }),
  },
});
mock.module("../src/utils/http.js", {
  namedExports: { fetchWithTimeout: async () => boom(), isTimeoutError: () => false },
});

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;
type Registered = { name: string; config: { description: string; inputSchema: Record<string, unknown> }; handler: Handler };

async function harness() {
  const { registerSurfTool, SURF_PRICE_USD } = await import("../src/tools/surf.js");
  let registered: Registered | undefined;
  let dialogs = 0;
  const server = {
    registerTool: (name: string, config: Registered["config"], handler: Handler) => { registered = { name, config, handler }; },
    server: {
      getClientCapabilities: () => ({ elicitation: {} }),
      // A confirm dialog for a route that cannot succeed is the bug; count it.
      elicitInput: async () => { dialogs++; return { action: "accept", content: { approve: true } }; },
    },
  };
  const budget: BudgetState = { limit: null, spent: 0, calls: 0, agents: new Map() };
  registerSurfTool(server as never, budget);
  assert.ok(registered, "blockrun_surf did not register");
  return { ...registered!, budget, dialogs: () => dialogs, reserve: SURF_PRICE_USD };
}

test("blockrun_surf stays registered under its name (the 20-tool count is pinned elsewhere)", async () => {
  const { name } = await harness();
  assert.equal(name, "blockrun_surf");
});

test("a surf call returns the retirement notice without reserving, asking, or sending", async () => {
  const { handler, budget, dialogs } = await harness();
  networkCalls = 0;
  for (const args of [
    { path: "market/price", params: { symbol: "ETH" } },
    { path: "/v1/surf/onchain/sql", body: { sql: "SELECT 1" } },
    { path: "wallet/labels/batch", params: { addresses: "0xabc" }, agent_id: "research" },
  ]) {
    const res = await handler(args);
    const text = res.content.map((p) => p.text ?? "").join("\n");
    assert.equal(res.isError, true, `${args.path}: a retired route is an error result, not data`);
    assert.match(text, /retired/i, `${args.path}: must say the route is retired`);
    assert.match(text, /2026-09-06/, `${args.path}: must carry the retirement date the gateway reports`);
    assert.match(text, /nothing was charged/i, `${args.path}: must say no money moved`);
    assert.match(text, /410/, `${args.path}: names the gateway's status so the user can verify it for free`);
    // The gateway's own alternatives list, translated into the tools that serve them.
    for (const alt of ["blockrun_price", "blockrun_defi", "blockrun_markets", "blockrun_dex"]) {
      assert.match(text, new RegExp(alt), `${args.path}: should route the user to ${alt}`);
    }
    // Do not oversell: SQL/labels/social have no BlockRun replacement yet.
    assert.match(text, /no BlockRun replacement/i, `${args.path}: must not pretend SQL/labels/social moved somewhere`);
    // Do not print funding advice — a 410 is not a wallet problem.
    assert.doesNotMatch(text, /needs funding|action: "setup"/, `${args.path}: a 410 must not be dressed as an empty wallet`);
  }
  assert.equal(networkCalls, 0, "reached the network for a route the gateway retired");
  assert.equal(budget.spent, 0, "left a reservation behind for a call that can never settle");
  assert.equal(budget.calls, 0, "counted a call that never left the process");
  assert.equal(dialogs(), 0, "showed a BLOCKRUN_CONFIRM_SPEND dialog for a charge that cannot happen");
});

test("path traversal is still rejected first, with the generic invalid-path error", async () => {
  const { handler } = await harness();
  const res = await handler({ path: "..\t/phone/numbers/buy" });
  assert.equal(res.isError, true);
  assert.match(res.content[0]?.text ?? "", /Invalid path/);
  assert.doesNotMatch(res.content[0]?.text ?? "", /retired/i);
});

test("surfRetiredMessage echoes the caller's path so the agent can see what it asked for", async () => {
  const { surfRetiredMessage, SURF_RETIRED_ON } = await import("../src/tools/surf.js");
  assert.equal(SURF_RETIRED_ON, "2026-09-06");
  const msg = surfRetiredMessage("social/mindshare");
  assert.match(msg, /social\/mindshare/);
  assert.match(msg, /^Error: /, "formatted like every other tool error");
});

test("the description sells the retirement, not 83 endpoints at $0.0095", async () => {
  const { config } = await harness();
  const d = config.description;
  assert.match(d, /retired/i);
  assert.match(d, /2026-09-06/);
  assert.doesNotMatch(d, /83 endpoints|\$0\.0095|\$0\.0085|tx fee|one API/i, "still advertises a dead paid catalog");
  for (const alt of ["blockrun_price", "blockrun_defi", "blockrun_markets", "blockrun_dex"]) {
    assert.match(d, new RegExp(alt), `description should name ${alt} as a replacement`);
  }
  // Every description token is charged to the user's context on every turn. A
  // retired tool has nothing to teach; the notice must be shorter than the
  // catalog pitch it replaces (which ran ~1,100 characters).
  assert.ok(d.length < 700, `retired description is ${d.length} chars; keep it under 700`);
});

test("the reserve constant is untouched — the gate must stay conservative if the namespace ever revives", async () => {
  const { reserve } = await harness();
  assert.equal(reserve, 0.0095);
});
