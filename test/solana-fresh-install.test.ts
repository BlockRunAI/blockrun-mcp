// Run with: npm test  (tsx --experimental-test-module-mocks --test)
//
// Solana has been the fresh-install default since 0.46.0, but nothing on that
// path minted a wallet: getWalletInfo() went through getClient() into the SDK
// constructor, which threw "Private key required" for every status/setup/qr/
// deposit call — including the one the tool description tells a new user to
// run first. The EVM path never had this problem because it auto-creates.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "blockrun-fresh-"));
fs.mkdirSync(path.join(home, ".blockrun"), { recursive: true });
const saved = {
  HOME: process.env.HOME,
  BLOCKRUN_KEYCHAIN: process.env.BLOCKRUN_KEYCHAIN,
  SOLANA_WALLET_KEY: process.env.SOLANA_WALLET_KEY,
  BLOCKRUN_WALLET_KEY: process.env.BLOCKRUN_WALLET_KEY,
  BLOCKRUN_API_KEY: process.env.BLOCKRUN_API_KEY,
  SOLANA_RPC_URL: process.env.SOLANA_RPC_URL,
};
process.env.HOME = home;
process.env.BLOCKRUN_KEYCHAIN = "off";
delete process.env.SOLANA_WALLET_KEY;
delete process.env.BLOCKRUN_WALLET_KEY;
delete process.env.BLOCKRUN_API_KEY;
process.env.SOLANA_RPC_URL = "https://rpc.test.invalid/solana";

const wallet = await import("../src/utils/wallet.js");

process.on("exit", () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

test("a fresh install defaults to Solana and names the remedy instead of the SDK's constructor error", () => {
  assert.equal(wallet.getChain(), "solana");
  assert.equal(wallet.resolveSolanaKey(), undefined);
  assert.throws(() => wallet.getClient(), /No Solana wallet on this machine yet.*blockrun_wallet action:"setup".*Nothing was charged/);
});

test("getWalletInfo provisions the Solana wallet on a fresh install (mirrors the EVM branch)", async () => {
  const info = await wallet.getWalletInfo();
  assert.equal(info.network, "Solana");
  assert.equal(info.isNew, true);
  assert.ok(info.address && info.address.length > 30, `address: ${info.address}`);
  assert.ok(fs.existsSync(path.join(home, ".blockrun", ".solana-session")), "the session file was written");
  assert.equal(wallet.resolveSolanaKey() !== undefined, true, "a miss was not memoised; the new key is visible");
  assert.doesNotThrow(() => wallet.getClient(), "a client can now be built");
});

test("getChainBalance queries the DISPLAYED Solana address, not the client's own wallet", async () => {
  const realFetch = globalThis.fetch;
  const seen: unknown[] = [];
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    seen.push(JSON.parse(init?.body ?? "{}"));
    return new Response(JSON.stringify({ result: { value: [
      { account: { data: { parsed: { info: { tokenAmount: { uiAmount: 1.25 } } } } } },
      { account: { data: { parsed: { info: { tokenAmount: { uiAmount: 0.5 } } } } } },
    ] } }), { status: 200 });
  }) as typeof fetch;
  try {
    const bal = await wallet.getChainBalance("solana", "SomeOtherAddress1111111111111111111111111111");
    assert.equal(bal, 1.75);
    const req = seen[0] as { method: string; params: unknown[] };
    assert.equal(req.method, "getTokenAccountsByOwner");
    assert.equal(req.params[0], "SomeOtherAddress1111111111111111111111111111");

    globalThis.fetch = (async () => { throw new Error("ECONNRESET"); }) as typeof fetch;
    assert.equal(await wallet.getChainBalance("solana", "SomeOtherAddress1111111111111111111111111111"), null, "unreachable RPC reads as unavailable, never as $0");
  } finally {
    globalThis.fetch = realFetch;
  }
});
