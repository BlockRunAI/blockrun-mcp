// Run with: npm test  (tsx --experimental-test-module-mocks --test)
//
// Two transport-level facts about the relayer client (audit round 3, D15/D16):
//
//  D16 — @polymarket/builder-relayer-client's pollUntilState (what `wait()`
//        runs) console.logs "Waiting for transaction …" to STDOUT. In the
//        stdio MCP server stdout IS the JSON-RPC channel, so every deploy,
//        approval, redeem and withdraw batch injected a non-JSON line into the
//        protocol stream mid-money-operation. Everything the SDK prints must
//        reach stderr instead, and console.log must be restored afterwards.
//
//  D15 — the SDK builds its own axios instance (`httpClient.instance`), so the
//        underscore-header bridge and POLYMARKET_CLOB_PROXY agent installed on
//        the hoisted axios never reached relayer traffic, while client.ts's
//        comment claimed relayer.ts injected them. getRelayClient must install
//        both on that instance.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import axios from "axios";

const AGENT_SENTINEL = { sentinel: "https-proxy-agent" };
let proxyAgent: unknown = null;
const bridgedInstances: unknown[] = [];
let waitResult: { transactionHash?: string } | undefined = { transactionHash: "0x" + "ab".repeat(32) };

class FakeRelayClient {
  httpClient = { instance: axios.create() };
  async executeDepositWalletBatch() {
    console.log("Executing deposit wallet batch (sdk chatter)");
    return {
      transactionID: "batch-1",
      wait: async () => {
        console.log("Waiting for transaction batch-1 matching states: STATE_MINED,STATE_CONFIRMED...");
        console.info("Client side request creation took: 0.1 seconds");
        return waitResult;
      },
    };
  }
  async deployDepositWallet() {
    return {
      transactionID: "deploy-1",
      wait: async () => { console.log("Waiting for transaction deploy-1 …"); return { transactionHash: "0x" + "cd".repeat(32) }; },
    };
  }
  async getTransaction() {
    console.log("Transaction not found or not in given states, timing out!");
    return [{ state: "STATE_NEW" }];
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
    getClobProxyAgent: () => proxyAgent,
    installUnderscoreHeaderBridge: (inst: unknown) => { bridgedInstances.push(inst); },
  },
});
mock.module("../src/utils/polymarket/creds.js", {
  namedExports: {
    loadBuilderCreds: () => ({ key: "k", secret: "s", passphrase: "p", createdAt: "" }),
    saveBuilderCreds: () => {},
    loadL2Creds: () => null,
    saveL2Creds: () => {},
    invalidateL2Creds: () => {},
    loadDepositWalletForSigner: () => undefined,
    loadState: () => ({}),
    saveState: () => ({}),
  },
});

proxyAgent = AGENT_SENTINEL; // set before the client is first built (it is cached)
const { sendWalletBatch, deployDepositWallet, getRelayClient, getRelayerTransactionState } = await import("../src/utils/polymarket/relayer.js");
const DEPOSIT = "0x5d3eaa66AE01F1a907c8e0970D1D021C6Ff8EB26";
const CALLS = [{ target: DEPOSIT, value: "0", data: "0x" }] as never;

/** Capture stdout/stderr writes for the duration of `fn`. */
async function captureStreams<T>(fn: () => Promise<T>): Promise<{ out: string[]; err: string[]; result: T }> {
  const out: string[] = [];
  const err: string[] = [];
  const stdout = mock.method(process.stdout, "write", ((chunk: unknown) => { out.push(String(chunk)); return true; }) as never);
  const stderr = mock.method(process.stderr, "write", ((chunk: unknown) => { err.push(String(chunk)); return true; }) as never);
  try {
    const result = await fn();
    return { out, err, result };
  } finally {
    stdout.mock.restore();
    stderr.mock.restore();
  }
}

test("D16: nothing the SDK prints during a batch reaches stdout — it goes to stderr, and console.log is restored", async () => {
  const originalLog = console.log;
  const originalInfo = console.info;
  waitResult = { transactionHash: "0x" + "ab".repeat(32) };
  const { out, err, result } = await captureStreams(() => sendWalletBatch(CALLS, DEPOSIT, "Approval batch"));
  assert.equal(result.transactionHash, "0x" + "ab".repeat(32));
  assert.deepEqual(out, [], `stdout is the JSON-RPC channel; got: ${JSON.stringify(out)}`);
  assert.ok(err.some((l) => l.includes("Waiting for transaction batch-1")), `SDK chatter must land on stderr: ${JSON.stringify(err)}`);
  assert.ok(err.some((l) => l.includes("Executing deposit wallet batch")), "the submit's own log line too");
  assert.ok(err.some((l) => l.includes("request creation took")), "console.info as well");
  assert.equal(console.log, originalLog, "console.log must be restored after the batch");
  assert.equal(console.info, originalInfo, "console.info must be restored after the batch");
});

test("D16: the poll-timeout path (wait() undefined → getTransaction) is quiet on stdout too", async () => {
  waitResult = undefined;
  const { out, err } = await captureStreams(() => sendWalletBatch(CALLS, DEPOSIT, "Redeem").catch((e: Error) => e));
  assert.deepEqual(out, []);
  assert.ok(err.some((l) => l.includes("timing out")));
});

test("D16: deploy and the standalone state lookup are quiet on stdout", async () => {
  const deploy = await captureStreams(() => deployDepositWallet());
  assert.equal(deploy.result.transactionHash, "0x" + "cd".repeat(32));
  assert.deepEqual(deploy.out, []);
  const state = await captureStreams(() => getRelayerTransactionState("batch-1"));
  assert.equal(state.result, "STATE_NEW");
  assert.deepEqual(state.out, []);
});

test("D16: the redirect is scoped — console.log outside a relayer call is untouched", async () => {
  const originalLog = console.log;
  await sendWalletBatch(CALLS, DEPOSIT, "Approval batch").catch(() => undefined);
  assert.equal(console.log, originalLog);
  // Two overlapping batches must not leave a swapped console behind when the
  // first finishes before the second (ref-counted, not last-writer-wins).
  waitResult = { transactionHash: "0x" + "ab".repeat(32) };
  await Promise.all([
    sendWalletBatch(CALLS, DEPOSIT, "A"),
    sendWalletBatch(CALLS, DEPOSIT, "B"),
  ]);
  assert.equal(console.log, originalLog);
});

test("D15: the relayer's own axios instance gets the underscore-header bridge and the CLOB proxy agent", async () => {
  const client = (await getRelayClient()) as unknown as FakeRelayClient;
  const inst = client.httpClient.instance;
  assert.ok(bridgedInstances.includes(inst), "installUnderscoreHeaderBridge must be called with the relayer's axios instance");
  assert.equal(inst.defaults.httpsAgent, AGENT_SENTINEL, "POLYMARKET_CLOB_PROXY must apply to relayer traffic");
  assert.equal(inst.defaults.proxy, false, "axios env-proxy resolution must be off when an explicit agent is set (same as client.ts)");
  // Idempotent: a second getRelayClient returns the cached client and installs nothing twice.
  const before = bridgedInstances.length;
  await getRelayClient();
  assert.equal(bridgedInstances.length, before);
});
