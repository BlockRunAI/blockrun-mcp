// Run with: npm test  (tsx --experimental-test-module-mocks --test)
//
// blockrun_scrapecheck is a pass-through partner route: the caller hands us a
// URL and we pay a THIRD PARTY to fetch it. That makes two guards load-bearing,
// and both have to fire before a single micro-dollar is reserved:
//
//  1. SSRF. This process never fetches the URL — the gateway does, then
//     ScrapeCheck does. Without the guard a URL pointing at localhost / the
//     metadata endpoint / the private network is forwarded, quoted and PAID
//     for before it fails (or worse, succeeds) server-side. Same hole
//     blockrun_video closed; same fix.
//  2. Chain. Settlement goes to ScrapeCheck's BASE treasury and sol.blockrun.ai
//     does not carry the routes, so a Solana session must fail closed with an
//     actionable message rather than 404 against the wrong gateway.
//
// Plus the cost table, because the base price here is set by ScrapeCheck rather
// than by our own catalogue and can move without a BlockRun deploy.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import type { BudgetState } from "../src/types.js";

let activeChain: "base" | "solana" = "base";
let rawCalls = 0;
let lastEndpoint = "";
let lastBody: unknown = null;

mock.module("../src/utils/wallet.js", {
  namedExports: {
    getChain: () => activeChain,
    getClient: () => ({
      requestWithPaymentRaw: async (endpoint: string, body: unknown) => {
        rawCalls++;
        lastEndpoint = endpoint;
        lastBody = body;
        return { verdict: "pass", signature: "ed25519:deadbeef" };
      },
    }),
  },
});
// Hostname-keyed, no DNS: the real resolver is covered by ssrf.test.ts; here we
// only need "this hostname is private" to be decidable offline.
mock.module("../src/utils/ssrf.js", {
  namedExports: {
    isBlockedFetchHostResolved: async (hostname: string) =>
      hostname === "169.254.169.254" || hostname === "127.0.0.1.nip.io" || hostname === "localhost",
    isBlockedFetchHost: () => false,
  },
});

const { registerScrapecheckTool, estimateScrapecheckCost } = await import("../src/tools/scrapecheck.js");

function makeHarness(limit: number | null = null) {
  let handler: ((args: Record<string, unknown>) => Promise<any>) | undefined;
  const server = {
    registerTool: (_n: string, _c: unknown, h: any) => { handler = h; },
    server: { getClientCapabilities: () => ({}) },
  } as any;
  const budget: BudgetState = { limit, spent: 0, calls: 0, agents: new Map() };
  registerScrapecheckTool(server, budget);
  return { call: (args: Record<string, unknown>) => handler!(args), budget };
}

const OK = { claim: { price: "$45" }, asked: "what is the price?" };
const text = (res: any) => res.content.map((c: any) => c.text).join("\n");

test("reserves the CHARGED price, not ScrapeCheck's base", () => {
  // base + the gateway's flat tx fee (src/utils/tx-fee.ts). Reserving the base
  // would leave the gate short on every call.
  assert.equal(estimateScrapecheckCost("verify"), 0.012);
  assert.equal(estimateScrapecheckCost("presence"), 0.004);
});

test("an unknown tier reserves the EXPENSIVE tier, never the cheap one", () => {
  // Fail closed: the handler normalises to "verify", so the estimator must
  // agree. Reserving $0.004 for a $0.012 call is how a cap becomes a lie.
  for (const t of ["", "VERIFY", "full", "nonsense", "Presence"]) {
    assert.equal(estimateScrapecheckCost(t), 0.012, `tier "${t}" must not reserve the presence price`);
  }
});

test("SSRF: private, loopback, metadata and non-http(s) URLs are refused before ANY call or reservation", async () => {
  for (const url of [
    "file:///etc/passwd",
    "ftp://example.com/x",
    "http://169.254.169.254/latest/meta-data/",
    "https://127.0.0.1.nip.io/page",
    "http://localhost:8080/admin",
  ]) {
    rawCalls = 0;
    const { call, budget } = makeHarness();
    const res = await call({ url, ...OK });
    assert.equal(res.isError, true, text(res));
    assert.match(text(res), /http\(s\) URL|private\/loopback\/link-local|not a valid URL/);
    assert.equal(rawCalls, 0, `paid call was made for ${url}`);
    assert.equal(budget.spent, 0, `budget was touched for ${url}`);
  }
});

test("a public https page still goes through and books the spend once", async () => {
  rawCalls = 0;
  const { call, budget } = makeHarness();
  const res = await call({ url: "https://shop.example.com/item/1", ...OK });
  assert.notEqual(res.isError, true, text(res));
  assert.equal(rawCalls, 1);
  assert.equal(lastEndpoint, "/v1/scrapecheck/verify");
  assert.deepEqual(lastBody, { url: "https://shop.example.com/item/1", ...OK });
  assert.equal(budget.spent, 0.012);
});

test("tier:presence hits the cheap route and books the cheap price", async () => {
  rawCalls = 0;
  const { call, budget } = makeHarness();
  const res = await call({ url: "https://shop.example.com/item/1", ...OK, tier: "presence" });
  assert.notEqual(res.isError, true, text(res));
  assert.equal(lastEndpoint, "/v1/scrapecheck/verify-presence");
  assert.equal(budget.spent, 0.004);
});

test("Solana sessions fail closed with the switch-chain message — no call, no spend", async () => {
  activeChain = "solana";
  rawCalls = 0;
  const { call, budget } = makeHarness();
  const res = await call({ url: "https://shop.example.com/item/1", ...OK });
  activeChain = "base";
  assert.equal(res.isError, true, text(res));
  assert.match(text(res), /Base only/);
  assert.match(text(res), /action:chain chain:base/);
  assert.equal(rawCalls, 0, "a Solana session must not reach the Base-only route");
  assert.equal(budget.spent, 0);
});

test("the chain guard runs before the SSRF guard's DNS work and before the ledger", async () => {
  // Ordering matters for the error the user sees: on Solana with a bad URL the
  // actionable answer is "switch chains", not "that host is private".
  activeChain = "solana";
  const { call } = makeHarness();
  const res = await call({ url: "http://169.254.169.254/", ...OK });
  activeChain = "base";
  assert.match(text(res), /Base only/);
});

test("the budget gate rejects before paying, and a rejected call books nothing", async () => {
  rawCalls = 0;
  const { call, budget } = makeHarness(0.005); // under the $0.012 verify reserve
  const res = await call({ url: "https://shop.example.com/item/1", ...OK });
  assert.equal(res.isError, true, text(res));
  assert.match(text(res), /blockrun_wallet/);
  assert.equal(rawCalls, 0, "the gate must stop the call, not just record it");
  assert.equal(budget.spent, 0);
});
