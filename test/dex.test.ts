// Run with: npm test  (tsx --experimental-test-module-mocks --test)
//
// blockrun_dex spliced the caller's `token` straight into the DexScreener URL
// PATH. The `query`/`symbol` branch encodes; the token branch did not, so a
// model-supplied `../search?q=pepe` or `abc#x` rewrote the request and came
// back as "No pairs found" or another endpoint's answer labelled as token
// data. The host is fixed (no SSRF) and the tool is free, so this is a
// wrong-output bug, not a money one — but it was the only passthrough in the
// repo without a path guard.
//
// The wallet layer is mocked to throw on any use even though dex.ts never
// imports it: the wallet on a dev machine is real, and this harness must stay
// safe if the tool ever grows a paid branch.
import { test, mock } from "node:test";
import assert from "node:assert/strict";

const boom = () => { throw new Error("UNEXPECTED_WALLET_USE"); };
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
    getOrCreateWalletKey: () => boom(),
    getWalletInfo: async () => boom(),
  },
});

const requests: string[] = [];
mock.module("../src/utils/http.js", {
  namedExports: {
    fetchWithTimeout: async (url: string) => {
      requests.push(url);
      return { ok: true, status: 200, json: async () => ({ pairs: [] }) };
    },
    isTimeoutError: () => false,
  },
});

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;

async function harness() {
  const { registerDexTool, parseTokenAddresses } = await import("../src/tools/dex.js");
  let handler: Handler | undefined;
  let name = "";
  registerDexTool({ registerTool: (n: string, _c: unknown, h: Handler) => { name = n; handler = h; } } as never);
  assert.ok(handler, "blockrun_dex did not register");
  requests.length = 0;
  return { name, handler: handler!, parseTokenAddresses };
}

const EVM = "0x6982508145454Ce325dDbE47a25d4ec3d2311933"; // PEPE
const SOL = "So11111111111111111111111111111111111111112"; // wSOL

test("blockrun_dex stays registered under its name", async () => {
  const { name } = await harness();
  assert.equal(name, "blockrun_dex");
});

test("a well-formed EVM or Solana address reaches DexScreener unchanged", async () => {
  const { handler } = await harness();
  await handler({ token: EVM });
  await handler({ token: SOL });
  assert.deepEqual(requests, [
    `https://api.dexscreener.com/latest/dex/tokens/${EVM}`,
    `https://api.dexscreener.com/latest/dex/tokens/${SOL}`,
  ]);
});

test("whitespace is trimmed and a comma-separated list is passed through (DexScreener takes up to 30)", async () => {
  const { handler } = await harness();
  await handler({ token: `  ${EVM} , ${SOL} ` });
  assert.deepEqual(requests, [`https://api.dexscreener.com/latest/dex/tokens/${EVM},${SOL}`]);
});

test("a Sui coin type (with `::`) is accepted — the shape is an allow-list, not an EVM/Solana whitelist", async () => {
  const { handler } = await harness();
  await handler({ token: "0x2::sui::SUI" });
  assert.equal(requests.length, 1);
  assert.ok(requests[0].endsWith("/tokens/0x2::sui::SUI"));
});

test("anything URL syntax could reinterpret is refused before any request, as an error result", async () => {
  const { handler } = await harness();
  const bad = [
    "../search?q=pepe",     // path traversal + query
    "abc#x",                // fragment drops the tail
    "a/b",                  // extra path segment
    "..",                   // parent segment
    ".",                    // current segment
    ".hidden",              // dot-led segment
    "pepe?chain=solana",    // query
    "0x1234%2F..",          // percent-encoding
    "a b",                  // whitespace inside
    "So11+111",             // plus
    "x",                    // one char
    "   ",                  // blank
    ",,,",                  // only separators
    Array.from({ length: 31 }, () => EVM).join(","), // over the 30-address limit
  ];
  for (const token of bad) {
    const res = await handler({ token });
    assert.equal(res.isError, true, `${JSON.stringify(token)}: must be an error`);
    assert.match(res.content[0].text ?? "", /Invalid token address/, `${JSON.stringify(token)}: names the problem`);
    assert.match(res.content[0].text ?? "", /use query instead/, `${JSON.stringify(token)}: points at the search branch`);
  }
  assert.deepEqual(requests, [], "no request was sent for any rejected token");
});

test("an empty token is not an address at all — it falls through to the existing 'provide something' error", async () => {
  const { handler } = await harness();
  const res = await handler({ token: "" });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text ?? "", /Provide query, token address, or symbol/);
  assert.deepEqual(requests, []);
});

test("parseTokenAddresses: the shape guard in isolation", async () => {
  const { parseTokenAddresses } = await harness();
  assert.deepEqual(parseTokenAddresses(EVM), [EVM]);
  assert.deepEqual(parseTokenAddresses(`${EVM},${SOL}`), [EVM, SOL]);
  assert.deepEqual(parseTokenAddresses("EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs"), ["EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs"]); // TON, with _ and -
  assert.equal(parseTokenAddresses("../x"), null);
  assert.equal(parseTokenAddresses("a".repeat(201)), null, "200-char cap per address");
  assert.deepEqual(parseTokenAddresses("a".repeat(200)), ["a".repeat(200)]);
});

test("the query/symbol branch is unchanged and still encodes", async () => {
  const { handler } = await harness();
  await handler({ query: "pepe coin&x" });
  assert.deepEqual(requests, ["https://api.dexscreener.com/latest/dex/search?q=pepe%20coin%26x"]);
});
