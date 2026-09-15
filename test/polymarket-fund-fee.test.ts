// Run with: npm test  (tsx --experimental-test-module-mocks --test)
//
// action:"fund" pays a REAL $0.01 x402 fee from the Base wallet on every call
// (the gateway's /v1/polymarket/fund charge) — BlockRun API spend, the thing
// the budget ledger meters — yet it never reserved or booked it (audit round
// 3, D18): a delegated agent could call fund ten times and action:"report"
// still showed $0.00, the cap never tripped, and a gateway re-price of the
// route would be signed by the SDK with nothing in this repo recording it.
// Now: reserve the fee at the gate (before the dialog, before signing), book
// what the SDK observed on success, book the estimate when the outcome is
// unknown (the fee payment went out with the request), book nothing on a
// definite rejection.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import type { BudgetState } from "../src/types.js";

const VAULT = "0x5d3eaa66AE01F1a907c8e0970D1D021C6Ff8EB26";
const AGENT = "0xCC8c44AD3dc2A58D841c3EB26131E49b22665EF8";
const BRIDGE = "0x6a6827094a5809Df44b32adBEf26F233614F12c4";

let signed = 0;
let observedFeeUsd = 0.01; // what the SDK's 402 quote settled at
let postBehaviour: () => Promise<unknown> = async () => ({ success: true, deposit: { txHash: "0xDEP" } });
let stateFile: Record<string, unknown> = {};

class APIError extends Error {
  constructor(message: string, readonly statusCode: number) { super(message); this.name = "APIError"; }
}

mock.module("axios", { defaultExport: { post: async () => ({ data: { address: { evm: BRIDGE } } }) } });
mock.module("@blockrun/llm", {
  namedExports: {
    createPaymentPayload: async () => { signed++; return "BASE64"; },
    BlockrunClient: class {
      sessionTotalUsd = 0;
      getSpending() { return { totalUsd: this.sessionTotalUsd, calls: 1 }; }
      async post() {
        const out = await postBehaviour();
        this.sessionTotalUsd += observedFeeUsd; // the SDK settles the quote on a 2xx
        return out;
      }
    },
  },
});
mock.module("../src/utils/wallet.js", {
  namedExports: {
    getApiBase: () => "https://blockrun.ai/api",
    resolveGatewayUrl: (u: string) => u,
    getOrCreateWalletKey: () => "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    getChainBalance: async () => 100,
    getChain: () => "base",
  },
});
mock.module("../src/utils/polymarket/client.js", { namedExports: { getPolymarketAccount: () => ({ address: AGENT }) } });
mock.module("../src/utils/polymarket/positions.js", { namedExports: { getFundsAddress: () => VAULT } });
mock.module("../src/utils/polymarket/setup.js", { namedExports: { getPublicClient: () => ({ getCode: async () => "0x60006000" }) } });
mock.module("../src/utils/polymarket/creds.js", {
  namedExports: {
    loadState: () => ({ ...stateFile }),
    saveState: (patch: Record<string, unknown>) => { stateFile = { ...stateFile, ...patch }; return stateFile; },
  },
});

const { fundVault } = await import("../src/utils/polymarket/fund.js");

function freshBudget(limit: number | null = null): BudgetState {
  return { limit, spent: 0, calls: 0, agents: new Map() };
}

function reset() {
  signed = 0;
  observedFeeUsd = 0.01;
  stateFile = {};
  postBehaviour = async () => ({ success: true, deposit: { txHash: "0xDEP" } });
}

test("a confirmed funding call books the fee the gateway settled", async () => {
  reset();
  const budget = freshBudget();
  const res = await fundVault({ amount_usd: 5, confirm: true, budget, agent_id: "bot" });
  assert.equal(res.isError, undefined, res.text);
  assert.ok(Math.abs(budget.spent - 0.01) < 1e-9, `spent ${budget.spent}`);
  assert.equal(budget.calls, 1);
});

test("a re-priced route is booked at what the SDK observed, not the $0.01 constant", async () => {
  reset();
  observedFeeUsd = 0.03;
  const budget = freshBudget();
  await fundVault({ amount_usd: 5, confirm: true, budget });
  assert.ok(Math.abs(budget.spent - 0.03) < 1e-9, `spent ${budget.spent}`);
});

test("a budget cap that the fee would cross refuses BEFORE signing the authorization", async () => {
  reset();
  const budget = freshBudget(0.005);
  const res = await fundVault({ amount_usd: 5, confirm: true, budget });
  assert.equal(res.isError, true);
  assert.match(res.text, /budget|cap/i);
  assert.equal(signed, 0, "no EIP-3009 authorization may be signed past the cap");
  assert.equal(budget.spent, 0, "a refused gate leaves no reservation");
});

test("a delegated agent's own cap is enforced and its spend attributed", async () => {
  reset();
  const budget = freshBudget();
  const { delegateAgent } = await import("../src/utils/budget.js");
  delegateAgent(budget, "bot", 0.015);
  const first = await fundVault({ amount_usd: 5, confirm: true, budget, agent_id: "bot" });
  assert.equal(first.isError, undefined, first.text);
  const second = await fundVault({ amount_usd: 5, confirm: true, budget, agent_id: "bot" });
  assert.equal(second.isError, true, "the second $0.01 would take the agent to $0.02 > $0.015");
  assert.equal(signed, 1);
  assert.ok(Math.abs((budget.agents.get("bot")?.spent ?? 0) - 0.01) < 1e-9);
});

test("a definite 4xx books nothing — the gateway rejected before charging", async () => {
  reset();
  postBehaviour = async () => { throw new APIError("HTTP 400", 400); };
  const budget = freshBudget();
  const res = await fundVault({ amount_usd: 5, confirm: true, budget });
  assert.equal(res.isError, true);
  assert.equal(budget.spent, 0);
});

test("an unknown outcome books the fee estimate — the fee payment left with the request", async () => {
  reset();
  postBehaviour = async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); };
  const budget = freshBudget();
  const res = await fundVault({ amount_usd: 5, confirm: true, budget });
  assert.equal(res.isError, true);
  assert.match(res.text, /outcome UNKNOWN/i);
  assert.ok(Math.abs(budget.spent - 0.01) < 1e-9, `spent ${budget.spent}`);
});

test("a dry-run reserves and books nothing", async () => {
  reset();
  const budget = freshBudget(0.005); // even under a cap the fee would cross
  const res = await fundVault({ amount_usd: 5, budget });
  assert.equal(res.isError, undefined, res.text);
  assert.match(res.text, /DRY RUN/);
  assert.equal(budget.spent, 0);
});

test("without a budget (legacy wiring) behaviour is unchanged", async () => {
  reset();
  const res = await fundVault({ amount_usd: 5, confirm: true });
  assert.equal(res.isError, undefined, res.text);
  assert.equal(signed, 1);
});
