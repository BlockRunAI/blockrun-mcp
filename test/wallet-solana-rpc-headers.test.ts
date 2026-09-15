// Run with: npm test  (tsx --experimental-test-module-mocks --test)
//
// 0.50.0 "around the edges": `SOLANA_RPC_HEADERS` is honoured again by the
// Solana USDC balance read. The SDK reads it alongside SOLANA_RPC_URL, and
// taking the balance query off the SDK (so the status screen shows the
// balance of the address it displays, not of the client's own key) dropped
// it — a private RPC that authenticates by header answered 401 and every
// balance read "unavailable". Fixed, and never pinned: a refactor that drops
// the merge again ships with the suite green.
//
// getSolanaUsdcBalance() uses global fetch directly (not utils/http.ts), so
// the request it sends is captured by replacing fetch. No RPC is reached.
import { test } from "node:test";
import assert from "node:assert/strict";
import { getChainBalance } from "../src/utils/wallet.js";

const ADDRESS = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const USDC_SOLANA_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

type Captured = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

async function balanceWith(env: { SOLANA_RPC_HEADERS?: string; SOLANA_RPC_URL?: string }, reply: unknown): Promise<{ captured: Captured; balance: number | null }> {
  const saved = { headers: process.env.SOLANA_RPC_HEADERS, url: process.env.SOLANA_RPC_URL };
  if (env.SOLANA_RPC_HEADERS === undefined) delete process.env.SOLANA_RPC_HEADERS; else process.env.SOLANA_RPC_HEADERS = env.SOLANA_RPC_HEADERS;
  if (env.SOLANA_RPC_URL === undefined) delete process.env.SOLANA_RPC_URL; else process.env.SOLANA_RPC_URL = env.SOLANA_RPC_URL;
  const realFetch = globalThis.fetch;
  let captured: Captured | undefined;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    captured = {
      url: String(input),
      headers: Object.fromEntries([...headers.entries()]),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    };
    return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const balance = await getChainBalance("solana", ADDRESS);
    assert.ok(captured, "the balance read must issue exactly one RPC request");
    return { captured: captured!, balance };
  } finally {
    globalThis.fetch = realFetch;
    if (saved.headers === undefined) delete process.env.SOLANA_RPC_HEADERS; else process.env.SOLANA_RPC_HEADERS = saved.headers;
    if (saved.url === undefined) delete process.env.SOLANA_RPC_URL; else process.env.SOLANA_RPC_URL = saved.url;
  }
}

const tokenAccounts = (uiAmounts: number[]) => ({
  jsonrpc: "2.0",
  id: 1,
  result: { value: uiAmounts.map((uiAmount) => ({ account: { data: { parsed: { info: { tokenAmount: { uiAmount } } } } } })) },
});

test("SOLANA_RPC_HEADERS is sent on the balance request, alongside the JSON content type", async () => {
  const { captured, balance } = await balanceWith(
    { SOLANA_RPC_HEADERS: '{"x-api-key":"k-123","Authorization":"Bearer t"}', SOLANA_RPC_URL: "https://private.rpc.example/solana" },
    tokenAccounts([4.5, 0.5]),
  );
  assert.equal(captured.url, "https://private.rpc.example/solana", "SOLANA_RPC_URL selects the endpoint");
  assert.equal(captured.headers["x-api-key"], "k-123", "the authenticating header must reach the private RPC — without it the RPC answers 401 and the balance reads 'unavailable'");
  assert.equal(captured.headers["authorization"], "Bearer t");
  assert.equal(captured.headers["content-type"], "application/json", "merging the extra headers must not drop the content type");
  assert.equal(captured.body.method, "getTokenAccountsByOwner");
  assert.deepEqual((captured.body.params as unknown[])[0], ADDRESS, "the balance is keyed on the address DISPLAYED, not the client's own key");
  assert.deepEqual((captured.body.params as unknown[])[1], { mint: USDC_SOLANA_MINT });
  assert.equal(balance, 5, "token accounts are summed");
});

test("without SOLANA_RPC_HEADERS the request carries only the content type, on the default gateway RPC", async () => {
  const { captured, balance } = await balanceWith({}, tokenAccounts([1.25]));
  assert.deepEqual(Object.keys(captured.headers), ["content-type"]);
  assert.equal(captured.url, "https://sol.blockrun.ai/api/v1/solana/rpc");
  assert.equal(balance, 1.25);
});

test("a malformed SOLANA_RPC_HEADERS falls through unauthenticated, as the SDK does, rather than failing the read", async () => {
  const { captured, balance } = await balanceWith({ SOLANA_RPC_HEADERS: "{not json" }, tokenAccounts([2]));
  assert.deepEqual(Object.keys(captured.headers), ["content-type"]);
  assert.equal(balance, 2);
});

test("a non-object SOLANA_RPC_HEADERS (an array, a string) is ignored, not spread into the request", async () => {
  const arr = await balanceWith({ SOLANA_RPC_HEADERS: '["x-api-key","k"]' }, tokenAccounts([1]));
  assert.deepEqual(Object.keys(arr.captured.headers), ["content-type"]);
  const str = await balanceWith({ SOLANA_RPC_HEADERS: '"x-api-key: k"' }, tokenAccounts([1]));
  assert.deepEqual(Object.keys(str.captured.headers), ["content-type"]);
});

test("an RPC error answers null (unavailable), never 0 beside a funded address", async () => {
  const { balance } = await balanceWith(
    { SOLANA_RPC_HEADERS: '{"x-api-key":"k"}' },
    { jsonrpc: "2.0", id: 1, error: { code: -32600, message: "unauthorized" } },
  );
  assert.equal(balance, null);
});
