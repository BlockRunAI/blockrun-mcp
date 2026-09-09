// Run with: npm test  (tsx --experimental-test-module-mocks --test)
//
// Pins WHICH errors redeem runs through mapClobError (late audit finding).
// Only the two CLOB calls (client + getMarket) can produce CLOB errors; the
// balance reads, relayer batch and receipt checks cannot — yet every caught
// error used to be mapped, so an RPC "403" became geoblock advice and any
// message containing "closed" became "market resolved, go redeem" — while the
// user was already inside redeem. Deps are mocked; no network, no signing.
import { test, mock } from "node:test";
import assert from "node:assert/strict";

const OWNER = "0x5d3eaa66AE01F1a907c8e0970D1D021C6Ff8EB26";
const CONDITION = "0x1fb90afceb91eb91255088d674e7f3530b83464762f9759a3073191746971cf5";

let getMarketError: unknown;
let readContractError: unknown;
let batchError: unknown;
let geoblockCalls = 0;

mock.module("../src/utils/polymarket/client.js", {
  namedExports: {
    getClobClient: async () => ({
      getMarket: async () => {
        if (getMarketError) throw getMarketError;
        return {
          question: "Resolved?",
          neg_risk: false,
          closed: true,
          tokens: [{ token_id: "1", outcome: "Yes", winner: true }, { token_id: "2", outcome: "No", winner: false }],
        };
      },
      getOrderBook: async () => ({ neg_risk: false }),
    }),
    getPolymarketAccount: () => ({ address: "0xCC8c44AD3dc2A58D841c3EB26131E49b22665EF8" }),
    checkGeoblock: async () => { geoblockCalls++; return { orderPlacement: "blocked", country: "US", ip: null, raw: {} }; },
    resetClobClient: () => {},
    getClobProxyAgent: () => null,
    installUnderscoreHeaderBridge: () => {},
  },
});
mock.module("../src/utils/polymarket/positions.js", {
  namedExports: { getFundsAddress: () => OWNER },
});
mock.module("../src/utils/polymarket/setup.js", {
  namedExports: {
    getPublicClient: () => ({
      readContract: async ({ args }: { args: [string, bigint] }) => {
        if (readContractError) throw readContractError;
        return args[1] === 1n ? 1_000_000n : 0n;
      },
      waitForTransactionReceipt: async () => ({ status: "success" }),
    }),
    getPusdBalance: async () => 0,
  },
});
mock.module("../src/utils/polymarket/relayer.js", {
  namedExports: {
    sendWalletBatch: async () => {
      if (batchError) throw batchError;
      return { transactionHash: "0x" + "ab".repeat(32) };
    },
    getRelayerTransactionState: async () => undefined,
    BATCH_DEADLINE_SECS: 300,
  },
});

const { redeemPosition } = await import("../src/utils/polymarket/redeem.js");

function reset() {
  getMarketError = undefined;
  readContractError = undefined;
  batchError = undefined;
  geoblockCalls = 0;
  delete process.env.POLYMARKET_SIG_TYPE; // deposit-wallet mode → relayer batch path
}

test("a CLOB 403 on the market lookup still gets the geoblock diagnosis", async () => {
  reset();
  // clob-client-v2 surfaces normalized {status, data, message} objects, not AxiosErrors.
  getMarketError = { status: 403, message: "Request failed with status code 403", data: "forbidden" };
  const res = await redeemPosition({ condition_id: CONDITION });
  assert.equal(res.isError, true);
  assert.match(res.text, /geoblock/);
  assert.equal(geoblockCalls, 1);
});

test("an RPC error carrying '403' or 'closed' is NOT rewritten into CLOB trading advice", async () => {
  for (const message of ["Request failed with status code 403", "Connection closed by peer"]) {
    reset();
    readContractError = Object.assign(new Error(message), { status: message.includes("403") ? 403 : undefined });
    const res = await redeemPosition({ condition_id: CONDITION, confirm: true });
    assert.equal(res.isError, true);
    assert.match(res.text, new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the raw message must survive");
    assert.doesNotMatch(res.text, /geoblock|POLYMARKET_CLOB_HOST|not accepting orders|Polymarket CLOB error/);
    assert.equal(geoblockCalls, 0, "no CLOB call failed, so the geoblock probe must not run");
  }
});

test("a relayer failure keeps its retry-safe wording, the approval hint, and no CLOB prefix", async () => {
  reset();
  batchError = new Error(
    'Redeem: relayer batch failed on-chain (tx t1). re-run action:"positions" to see whether the position was consumed before retrying',
  );
  const res = await redeemPosition({ condition_id: CONDITION, confirm: true });
  assert.equal(res.isError, true);
  assert.ok(res.text.startsWith("Redeem: relayer batch failed on-chain"), `got: ${res.text}`);
  assert.match(res.text, /collateral-adapter/, "the revert → approval hint still fires on 'failed'");
  assert.doesNotMatch(res.text, /Polymarket CLOB error/);
});
