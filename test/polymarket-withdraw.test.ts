// Run with: npm test  (tsx --experimental-test-module-mocks --test)
//
// Withdraw dry-run, amount validation, the legacy USDC.e sweep, and the
// double-spend guard (the confirm path's bridge/relayer calls are exercised in
// the live e2e scripts, not here). Deps are mocked so no network/RPC.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData } from "viem";
import { COLLATERAL_ONRAMP, ERC20_ABI, USDCE_COLLATERAL } from "../src/utils/polymarket/constants.js";

const DEPOSIT = "0x5d3eaa66AE01F1a907c8e0970D1D021C6Ff8EB26";
const AGENT = "0xCC8c44AD3dc2A58D841c3EB26131E49b22665EF8";
let pusdRaw = 7_500_000n; // $7.50 pUSD (6 decimals)
let usdceRaw = 0n;

// Mutable state-file + relayer doubles so the double-spend guard is testable.
let stateFile: Record<string, unknown> = {};
let relayerState: string | undefined;
let relayerStateCalls = 0;

mock.module("../src/utils/polymarket/positions.js", {
  namedExports: { getFundsAddress: () => DEPOSIT },
});
mock.module("../src/utils/polymarket/setup.js", {
  namedExports: {
    getPublicClient: () => ({
      readContract: async ({ address }: { address: string }) =>
        address.toLowerCase() === USDCE_COLLATERAL.toLowerCase() ? usdceRaw : pusdRaw,
      waitForTransactionReceipt: async () => ({ status: "success" }),
    }),
    getPusdBalance: async () => Number(pusdRaw) / 1e6,
  },
});
// client.js is imported (transitively via orders.js/relayer.js) for several
// exports — stub them all so the mock doesn't drop any.
mock.module("../src/utils/polymarket/client.js", {
  namedExports: {
    getPolymarketAccount: () => ({ address: AGENT }),
    checkGeoblock: async () => ({ orderPlacement: "permitted", country: "JP", ip: null, raw: {} }),
    getClobClient: async () => { throw new Error("clob client not used in withdraw dry-run"); },
    resetClobClient: () => {},
    getClobProxyAgent: () => null,
    installUnderscoreHeaderBridge: () => {},
  },
});
mock.module("../src/utils/polymarket/creds.js", {
  namedExports: {
    loadState: () => ({ ...stateFile }),
    saveState: (patch: Record<string, unknown>) => { stateFile = { ...stateFile, ...patch }; return stateFile; },
    loadDepositWalletForSigner: () => DEPOSIT,
    loadL2Creds: () => null,
    saveL2Creds: () => {},
    invalidateL2Creds: () => {},
    loadBuilderCreds: () => null,
    saveBuilderCreds: () => {},
  },
});
mock.module("../src/utils/polymarket/relayer.js", {
  namedExports: {
    sendWalletBatch: async () => ({ transactionHash: "0x" + "ab".repeat(32) }),
    getRelayerTransactionState: async () => { relayerStateCalls++; return relayerState; },
    BATCH_DEADLINE_SECS: 300,
  },
});
// The confirm path's first network touch is the bridge POST — fail it loudly
// so tests can prove the guard LET a call through without real I/O. The thrown
// error is swappable so the error-routing tests can shape it like axios.
const BRIDGE_OFFLINE = new Error("bridge offline (test)");
let bridgeError: unknown = BRIDGE_OFFLINE;
mock.module("axios", {
  defaultExport: {
    post: async () => { throw bridgeError; },
    get: async () => { throw bridgeError; },
  },
});

const { buildLegacyWrapCalls, parseUsdAmount, withdrawFunds } = await import("../src/utils/polymarket/withdraw.js");

test("no confirm → dry-run previews full balance to the agent wallet on Base", async () => {
  pusdRaw = 7_500_000n; usdceRaw = 0n; stateFile = {};
  const res = await withdrawFunds({});
  assert.equal(res.isError, undefined, res.text);
  assert.match(res.text, /DRY RUN/);
  assert.match(res.text, /\$7\.50/);
  assert.match(res.text, /USDC on Base/);
  assert.match(res.text, new RegExp(AGENT));
  assert.equal((res.structured as { dryRun?: boolean }).dryRun, true);
  assert.equal((res.structured as { toChainId?: number }).toChainId, 8453);
});

test("amount_usd caps the withdrawal to that amount", async () => {
  pusdRaw = 7_500_000n; usdceRaw = 0n; stateFile = {};
  const res = await withdrawFunds({ amount_usd: 3 });
  assert.match(res.text, /\$3\.00/);
});

test("amount above balance is rejected", async () => {
  pusdRaw = 7_500_000n; usdceRaw = 0n; stateFile = {};
  const res = await withdrawFunds({ amount_usd: 10 });
  assert.equal(res.isError, true);
  assert.match(res.text, /exceeds the withdrawable collateral balance/);
});

test("nothing to withdraw when both balances are zero", async () => {
  pusdRaw = 0n; usdceRaw = 0n; stateFile = {};
  const res = await withdrawFunds({});
  assert.equal(res.isError, true);
  assert.match(res.text, /No pUSD or USDC\.e to withdraw/);
});

test("custom to_address overrides the destination", async () => {
  pusdRaw = 5_000_000n; usdceRaw = 0n; stateFile = {};
  const other = "0x1111111111111111111111111111111111111111";
  const res = await withdrawFunds({ to_address: other });
  assert.match(res.text, new RegExp(other));
});

// --- Legacy USDC.e sweep (issue #71, design from #59/#66) ---

test("legacy USDC.e counts toward the balance and previews as a wrap", async () => {
  pusdRaw = 2_000_000n; usdceRaw = 3_000_000n; stateFile = {};
  const res = await withdrawFunds({});
  assert.equal(res.isError, undefined, res.text);
  assert.match(res.text, /\$5\.00/);
  assert.match(res.text, /First wrap: \$3\.00 legacy USDC\.e → pUSD/);
  assert.equal((res.structured as { wrapUsd?: number }).wrapUsd, 3);
  assert.equal((res.structured as { pusdUsd?: number }).pusdUsd, 2);
  assert.equal((res.structured as { usdceUsd?: number }).usdceUsd, 3);
});

test("no wrap is previewed when pUSD alone covers the amount", async () => {
  pusdRaw = 5_000_000n; usdceRaw = 3_000_000n; stateFile = {};
  const res = await withdrawFunds({ amount_usd: 4 });
  assert.equal(res.isError, undefined, res.text);
  assert.doesNotMatch(res.text, /First wrap/);
  assert.equal((res.structured as { wrapUsd?: number }).wrapUsd, 0);
});

test("the wrap batch is approve → exact-amount wrap, pinned by calldata", () => {
  const amount = 3_000_000n;
  const [approve, wrap] = buildLegacyWrapCalls(DEPOSIT, amount);
  assert.equal(approve.target.toLowerCase(), USDCE_COLLATERAL.toLowerCase());
  assert.equal(wrap.target.toLowerCase(), COLLATERAL_ONRAMP.toLowerCase());
  const decodedApprove = decodeFunctionData({ abi: ERC20_ABI, data: approve.data });
  assert.equal(decodedApprove.functionName, "approve");
  assert.deepEqual(decodedApprove.args, [COLLATERAL_ONRAMP, amount]);
  const decodedWrap = decodeFunctionData({
    abi: [{ type: "function", name: "wrap", stateMutability: "nonpayable", inputs: [
      { name: "_asset", type: "address" }, { name: "_to", type: "address" }, { name: "_amount", type: "uint256" },
    ], outputs: [] }] as const,
    data: wrap.data,
  });
  assert.equal(decodedWrap.functionName, "wrap");
  assert.deepEqual(decodedWrap.args, [USDCE_COLLATERAL, DEPOSIT, amount]);
});

// --- Amount parsing (precision must never silently change the request) ---

test("parseUsdAmount rounds to the exact micro-dollar, not down through float noise", () => {
  // 19.99 * 1e6 is 19_989_999.999…; the old floor lost a cent.
  assert.equal(parseUsdAmount(19.99), 19_990_000n);
  assert.equal(parseUsdAmount(2), 2_000_000n);
  assert.equal(parseUsdAmount(0.000001), 1n);
});

test("rejects non-positive and over-precision amounts before any network call", async () => {
  pusdRaw = 7_500_000n; usdceRaw = 0n; stateFile = {};
  for (const amount_usd of [0, -1, 1.0000001, Number.NaN]) {
    const res = await withdrawFunds({ amount_usd });
    assert.equal(res.isError, true, `amount ${amount_usd} should be rejected`);
    assert.match(res.text, /positive USD amount/);
  }
});

// --- Double-spend guard (issue #72 finding 1) ---

const futureDeadline = () => Math.floor(Date.now() / 1000) + 200;

test("an unresolved in-flight withdrawal blocks signing a second one", async () => {
  pusdRaw = 7_500_000n; usdceRaw = 0n;
  stateFile = { pendingWithdraw: { transactionID: "relayer-tx-1", deadline: futureDeadline() } };
  relayerState = "STATE_NEW"; // still executable
  const res = await withdrawFunds({ amount_usd: 2, confirm: true });
  assert.equal(res.isError, true);
  assert.match(res.text, /may still execute/);
  assert.match(res.text, /double-send/);
});

test("an unreachable relayer counts as unresolved — conservative side", async () => {
  pusdRaw = 7_500_000n; usdceRaw = 0n;
  stateFile = { pendingWithdraw: { transactionID: "relayer-tx-1", deadline: futureDeadline() } };
  relayerState = undefined;
  const res = await withdrawFunds({ amount_usd: 2, confirm: true });
  assert.equal(res.isError, true);
  assert.match(res.text, /double-send/);
});

test("a resolved (mined) in-flight withdrawal clears the guard and proceeds", async () => {
  pusdRaw = 7_500_000n; usdceRaw = 0n;
  stateFile = { pendingWithdraw: { transactionID: "relayer-tx-1", deadline: futureDeadline() } };
  relayerState = "STATE_MINED";
  const res = await withdrawFunds({ amount_usd: 2, confirm: true });
  // Proceeding means reaching the bridge POST, which the axios mock fails loudly.
  assert.equal(res.isError, true);
  assert.match(res.text, /bridge offline \(test\)/);
  assert.equal(stateFile.pendingWithdraw, undefined, "guard must be cleared");
});

test("an expired deadline clears the guard and proceeds", async () => {
  pusdRaw = 7_500_000n; usdceRaw = 0n;
  stateFile = { pendingWithdraw: { transactionID: "relayer-tx-1", deadline: Math.floor(Date.now() / 1000) - 3600 } };
  relayerState = "STATE_NEW";
  const res = await withdrawFunds({ amount_usd: 2, confirm: true });
  assert.match(res.text, /bridge offline \(test\)/);
  assert.equal(stateFile.pendingWithdraw, undefined);
});

test("the guard never blocks dry-runs", async () => {
  pusdRaw = 7_500_000n; usdceRaw = 0n;
  stateFile = { pendingWithdraw: { transactionID: "relayer-tx-1", deadline: futureDeadline() } };
  relayerState = "STATE_NEW";
  const res = await withdrawFunds({});
  assert.equal(res.isError, undefined, res.text);
  assert.match(res.text, /DRY RUN/);
});

test("parseUsdAmount accepts amounts whose float noise exceeds a naive absolute bound", () => {
  // 1234.56 * 1e6 = 1_234_559_999.9999998 — noise 2.4e-7 micro, which a 1e-7
  // absolute threshold (the #66 draft) wrongly rejected as over-precision.
  assert.equal(parseUsdAmount(1234.56), 1_234_560_000n);
});

// --- Destination validation + honest labelling (audit cluster F) ---
//
// The dry-run is the ONE human checkpoint before an irreversible pUSD → bridge
// transfer. It used to print "to (agent wallet): <addr>" for ANY to_address, so
// a hallucinated/injected third-party address was labelled as the user's own.

test("a custom to_address is labelled CUSTOM in the dry-run — never 'agent wallet'", async () => {
  pusdRaw = 5_000_000n; usdceRaw = 0n; stateFile = {};
  const other = "0x1111111111111111111111111111111111111111";
  const res = await withdrawFunds({ to_address: other });
  assert.equal(res.isError, undefined, res.text);
  assert.match(res.text, new RegExp(other));
  assert.match(res.text, /CUSTOM destination/);
  assert.match(res.text, /NOT your agent wallet/);
  assert.doesNotMatch(res.text, /to \(agent wallet\)/);
  assert.doesNotMatch(res.text, /\(your agent wallet\)/);
  assert.equal((res.structured as { to?: string }).to, other, "structured.to stays the raw destination");
});

test("to_address equal to the agent wallet (any case) is still labelled as the agent wallet", async () => {
  pusdRaw = 5_000_000n; usdceRaw = 0n; stateFile = {};
  const res = await withdrawFunds({ to_address: AGENT.toLowerCase() });
  assert.equal(res.isError, undefined, res.text);
  assert.match(res.text, /\(your agent wallet\)/);
  assert.doesNotMatch(res.text, /CUSTOM/);
});

test("the default destination (no to_address) is labelled as the agent wallet", async () => {
  pusdRaw = 5_000_000n; usdceRaw = 0n; stateFile = {};
  const res = await withdrawFunds({});
  assert.match(res.text, /\(your agent wallet\)/);
  assert.doesNotMatch(res.text, /CUSTOM/);
});

test("a mixed-case to_address with a bad checksum is refused before any I/O", async () => {
  pusdRaw = 5_000_000n; usdceRaw = 0n; stateFile = {};
  // AGENT with one letter's case flipped: EIP-55 checksum no longer matches —
  // the classic transposition/typo shape strict isAddress exists to catch.
  const badChecksum = "0xcC8c44AD3dc2A58D841c3EB26131E49b22665EF8";
  for (const to_address of [badChecksum, "0x1111", "vitalik.eth", "0x", "1111111111111111111111111111111111111111"]) {
    const res = await withdrawFunds({ to_address, confirm: true });
    assert.equal(res.isError, true, `${to_address} should be rejected`);
    assert.match(res.text, /to_address/);
    assert.match(res.text, /Nothing withdrawn/);
    // confirm:true → the first network touch would be the bridge POST, which the
    // axios mock fails loudly. Not seeing it proves we refused before any I/O.
    assert.doesNotMatch(res.text, /bridge offline/);
  }
});

test("an 'unknown' pendingWithdraw (lost submit response) blocks without asking the relayer", async () => {
  pusdRaw = 7_500_000n; usdceRaw = 0n;
  stateFile = { pendingWithdraw: { transactionID: "unknown", deadline: futureDeadline() } };
  relayerState = "STATE_MINED"; // would clear a KNOWN id — must not be consulted for "unknown"
  relayerStateCalls = 0;
  const res = await withdrawFunds({ amount_usd: 2, confirm: true });
  assert.equal(res.isError, true);
  assert.match(res.text, /double-send/);
  assert.match(res.text, /submit response was lost/);
  assert.equal(relayerStateCalls, 0, "there is no id to look up — the relayer must not be asked about 'unknown'");
  assert.ok(stateFile.pendingWithdraw, "the guard stays armed until the deadline passes");
});

// --- Error routing (late audit finding) ---
//
// withdraw never talks to the CLOB, yet every error used to go through
// mapClobError: a bridge 403 became "point POLYMARKET_CLOB_HOST + RELAYER_URL
// at a permitted-region relay" (the relay does not even serve the bridge), and
// any message containing "closed" became "market resolved, go redeem".

test("a bridge 403 is reported as a BRIDGE failure, not CLOB geoblock advice", async () => {
  pusdRaw = 7_500_000n; usdceRaw = 0n; stateFile = {};
  bridgeError = Object.assign(new Error("Request failed with status code 403"), {
    isAxiosError: true,
    response: { status: 403, data: { error: "forbidden" } },
  });
  try {
    const res = await withdrawFunds({ amount_usd: 2, confirm: true });
    assert.equal(res.isError, true);
    assert.match(res.text, /bridge/i);
    assert.match(res.text, /POLYMARKET_BRIDGE_HOST/);
    assert.match(res.text, /403/);
    assert.doesNotMatch(res.text, /POLYMARKET_CLOB_HOST|POLYMARKET_RELAYER_URL|geoblock/);
    assert.doesNotMatch(res.text, /Polymarket CLOB error/);
  } finally {
    bridgeError = BRIDGE_OFFLINE;
  }
});

test("a transport error is passed through verbatim, not reinterpreted as a resolved market", async () => {
  pusdRaw = 7_500_000n; usdceRaw = 0n; stateFile = {};
  bridgeError = new Error("Connection closed before a response was received");
  try {
    const res = await withdrawFunds({ amount_usd: 2, confirm: true });
    assert.equal(res.isError, true);
    assert.match(res.text, /Connection closed before a response was received/);
    assert.doesNotMatch(res.text, /not accepting orders|action:"redeem"/);
    assert.doesNotMatch(res.text, /Polymarket CLOB error/);
  } finally {
    bridgeError = BRIDGE_OFFLINE;
  }
});

test("relayer anti-retry guidance survives the error path untouched", async () => {
  pusdRaw = 7_500_000n; usdceRaw = 0n; stateFile = {};
  bridgeError = new Error(
    "Withdraw: relayer batch did not confirm within the polling window (tx t1, relayer state: STATE_NEW). " +
    "It may still land. Do NOT retry yet: wait for the deadline to pass, then check the pUSD balance.",
  );
  try {
    const res = await withdrawFunds({ amount_usd: 2, confirm: true });
    assert.equal(res.isError, true);
    assert.ok(res.text.startsWith("Withdraw: relayer batch did not confirm"), `got: ${res.text}`);
    assert.match(res.text, /Do NOT retry/);
  } finally {
    bridgeError = BRIDGE_OFFLINE;
  }
});
