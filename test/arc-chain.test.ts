// Run with: npm test  (tsx --experimental-test-module-mocks --test)
//
// Arc as the third wallet rail. It is an EVM chain that pays from the Base key
// against arc.blockrun.ai, so what can go wrong is narrow and specific: the
// chain not being selectable, a client still pointed at blockrun.ai (a Base
// 402 signed and settled on Base while the user believes they pay on Arc), a
// balance read from the wrong chain, or an install that never chose Arc being
// moved onto it. Pinned against a real temp HOME, like chain-precedence.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "blockrun-arc-"));
const blockrunDir = path.join(home, ".blockrun");
fs.mkdirSync(blockrunDir, { recursive: true });
const realHome = process.env.HOME;
const savedKeychain = process.env.BLOCKRUN_KEYCHAIN;
const savedArcRpc = process.env.ARC_RPC_URL;
process.env.HOME = home;
process.env.BLOCKRUN_KEYCHAIN = "off";
delete process.env.ARC_RPC_URL;

const { getChain, setChain, getApiBase, getChainBalance, getWalletInfo, getClient, ARC_API_URL } =
  await import("../src/utils/wallet.js");
const { getEip681Uri } = await import("../src/utils/qr.js");

const ADDRESS = "0xCC8c44AD3dc2A58D841c3EB26131E49b22665EF8";
const realFetch = globalThis.fetch;

beforeEach(() => {
  for (const f of [".chain", ".chain-auto", ".solana-session", ".session"]) {
    fs.rmSync(path.join(blockrunDir, f), { force: true });
  }
  delete process.env.SOLANA_WALLET_KEY;
  delete process.env.ARC_RPC_URL;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

process.on("exit", () => {
  if (savedKeychain === undefined) delete process.env.BLOCKRUN_KEYCHAIN;
  else process.env.BLOCKRUN_KEYCHAIN = savedKeychain;
  if (savedArcRpc === undefined) delete process.env.ARC_RPC_URL;
  else process.env.ARC_RPC_URL = savedArcRpc;
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const writeBaseSession = () => fs.writeFileSync(path.join(blockrunDir, ".session"), `0x${"1".repeat(64)}`);

test("chain:\"arc\" is selectable, persisted, and points every hand-built URL at arc.blockrun.ai", () => {
  setChain("arc");
  assert.equal(fs.readFileSync(path.join(blockrunDir, ".chain"), "utf-8"), "arc");
  assert.equal(getChain(), "arc");
  assert.equal(getApiBase(), "https://arc.blockrun.ai/api");
  assert.equal(ARC_API_URL, "https://arc.blockrun.ai/api");
});

test("the SDK client pays against the Arc gateway, not blockrun.ai", () => {
  writeBaseSession();
  setChain("arc");
  const client = getClient() as unknown as { apiUrl: string };
  assert.equal(client.apiUrl, "https://arc.blockrun.ai/api");
  setChain("base");
  const baseClient = getClient() as unknown as { apiUrl: string };
  assert.equal(baseClient.apiUrl, "https://blockrun.ai/api", "switching back rebuilds the cached client");
});

test("nothing autodetects Arc: a Base-wallet install with no choice stays on Base", () => {
  writeBaseSession();
  assert.equal(getChain(), "base");
});

test("an unknown value in .chain is ignored, not trusted", () => {
  writeBaseSession();
  fs.writeFileSync(path.join(blockrunDir, ".chain"), "polygon");
  assert.equal(getChain(), "base");
});

test("wallet info on Arc names the chain, its id and its explorer, at the Base address", async () => {
  writeBaseSession();
  setChain("arc");
  const info = await getWalletInfo();
  assert.equal(info.network, "Arc");
  assert.equal(info.chainId, 5042);
  assert.match(info.explorerUrl ?? "", /^https:\/\/arc-scan\.org\/address\/0x[0-9a-fA-F]{40}$/);
  setChain("base");
  const baseInfo = await getWalletInfo();
  assert.equal(baseInfo.address, info.address, "one EVM key: Arc and Base share the address");
});

test("Arc balance reads the Arc gateway and parses micro-USDC", async () => {
  const seen: string[] = [];
  globalThis.fetch = (async (url: string | URL) => {
    seen.push(String(url));
    return new Response(JSON.stringify({ address: ADDRESS, balance: "24253720", network: "arc" }), { status: 200 });
  }) as typeof fetch;
  assert.equal(await getChainBalance("arc", ADDRESS), 24.25372);
  assert.deepEqual(seen, [`https://arc.blockrun.ai/api/v1/balance?address=${ADDRESS}`]);
});

test("a balance answer for another network is not shown as the Arc balance", async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ balance: "29890226", network: "base" }), { status: 200 })) as typeof fetch;
  assert.equal(await getChainBalance("arc", ADDRESS), null);
});

test("ARC_RPC_URL is asked first, with balanceOf on Arc's USDC", async () => {
  process.env.ARC_RPC_URL = "https://arc-rpc.example/v2/key";
  const bodies: unknown[] = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    assert.equal(String(url), "https://arc-rpc.example/v2/key");
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" + (5_000_000).toString(16) }), { status: 200 });
  }) as typeof fetch;
  assert.equal(await getChainBalance("arc", ADDRESS), 5);
  const call = (bodies[0] as { params: [{ to: string; data: string }] }).params[0];
  assert.equal(call.to, "0x3600000000000000000000000000000000000000");
  assert.ok(call.data.startsWith("0x70a08231"));
});

test("an Arc funding QR targets Arc's USDC on chain 5042", () => {
  const uri = getEip681Uri(ADDRESS, 1, "arc");
  assert.equal(uri, `ethereum:0x3600000000000000000000000000000000000000@5042/transfer?address=${ADDRESS}&uint256=1000000`);
  assert.match(getEip681Uri(ADDRESS), /@8453\//, "Base stays the default");
});
