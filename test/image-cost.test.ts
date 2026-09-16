// Run with: npm test  (tsx --experimental-test-module-mocks --test)
// Verifies the Cost footer added to blockrun_image, without any real spend:
// the auth rail is pinned to wallet/Base, the paid ImageClient and the chain
// selector are mocked, and the shared fetch helper is a trap — then the
// registered handler is invoked and its text/structured output is asserted.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { BudgetState } from "../src/types.js";

// Pin the RAIL before anything can load utils/auth.ts. image.ts asks
// isApiKeyMode() BEFORE it consults the mocked getChain()/getImageClient(), and
// that answer comes from the developer's own BLOCKRUN_API_KEY / ~/.blockrun/.api-key
// — so on a machine set up for account mode the six handler calls below used to
// leave the mocks entirely and POST to the gateway with the real Bearer key.
// Same discipline as auth-mode.test.ts: a temp HOME (auth.ts captures the key
// file path from os.homedir() at import time) and no env key. auth.js itself is
// NOT mocked — onramp.ts (imported by image.ts) needs PORTAL_CREDITS_URL from
// it, and a partial namedExports mock fails to link.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "blockrun-image-cost-"));
const realHome = process.env.HOME;
const savedApiKey = process.env.BLOCKRUN_API_KEY;
process.env.HOME = home;
delete process.env.BLOCKRUN_API_KEY;
process.on("exit", () => {
  if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
  if (savedApiKey === undefined) delete process.env.BLOCKRUN_API_KEY; else process.env.BLOCKRUN_API_KEY = savedApiKey;
  fs.rmSync(home, { recursive: true, force: true });
});

// Mock the wallet module BEFORE importing the tool: force Base chain and hand
// back a fake ImageClient whose generate/edit resolve to a hosted URL (no
// network, no payment).
const fakeImageClient = {
  generate: async () => ({ data: [{ url: "https://blockrun.ai/media/fake.png" }] }),
  edit: async () => ({ data: [{ url: "https://blockrun.ai/media/fake-edit.png" }] }),
};
mock.module("../src/utils/wallet.js", {
  namedExports: {
    getApiBase: () => "https://blockrun.ai/api",
    resolveGatewayUrl: (u: string) => (u.startsWith("http") ? u : `https://blockrun.ai/api${u.startsWith("/api/") ? u.slice(4) : u}`),

    getChain: () => "base",
    getImageClient: () => fakeImageClient,
    getOrCreateWalletKey: () => "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    getWalletInfo: async () => ({ address: "0xTEST" }),
    // image.ts statically imports utils/solana-402.ts, which now resolves the
    // Solana key through wallet.ts; this suite only exercises the Base path.
    resolveSolanaKey: () => undefined,
  },
});
// Belt and braces: every rail that is not the mocked ImageClient (account
// apiKeyPost, Solana manual x402) bottoms out in this helper. If a future
// change routes past the pin above, the test fails HERE, for the right reason,
// instead of reaching the network.
let networkCalls = 0;
mock.module("../src/utils/http.js", {
  namedExports: {
    fetchWithTimeout: async () => { networkCalls++; throw new Error("network call escaped the mocks"); },
    // The real predicate, restated. A `() => false` stub here (as this suite
    // had until audit round 3) hides the timeout branch from every test in
    // the file — which is how a dead in-flight booking stayed green.
    isTimeoutError: (err: unknown) => {
      const name = err instanceof Error ? err.name : "";
      if (name === "AbortError" || name === "TimeoutError") return true;
      const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
      return msg.includes("abort") || msg.includes("timeout") || msg.includes("timed out") || msg.includes("did not complete within");
    },
  },
});

const { registerImageTool, estimateCost } = await import("../src/tools/image.js");
const { isApiKeyMode } = await import("../src/utils/auth.js");

test("the suite runs on the wallet rail whatever the developer's account setup", () => {
  // If this fails, every handler test below is exercising the account rail —
  // and without the pin, a real key.
  assert.equal(isApiKeyMode(), false);
});

// Minimal McpServer stub: capture the handler registerImageTool installs.
function makeHarness() {
  let handler: ((args: Record<string, unknown>) => Promise<any>) | undefined;
  const server = {
    registerTool: (_name: string, _cfg: unknown, h: any) => { handler = h; },
    server: { getClientCapabilities: () => ({}) },
  } as any;
  const budget: BudgetState = { limit: null, spent: 0, calls: 0, agents: new Map() };
  registerImageTool(server, budget);
  return { call: (args: Record<string, unknown>) => handler!(args), budget };
}

// The Cost footer and the ledger must report what the user is CHARGED, not the
// catalog base and not the reserve. The gateway settles catalog x 1.05 + a
// transaction fee; the RESERVE (estimateCost) carries that fee at $0.002, the
// higher figure it has flip-flopped through, on purpose (see utils/tx-fee.ts).
// What the Base gateway is OBSERVED to charge is $0.001 — an unpaid 402 probe
// of /v1/images/generations on 2026-09-13 quoted cogview-4 at 16750 micro
// ($0.016750 = 0.015 x 1.05 + $0.001) against a $0.017751 reserve — so the
// footer and the ledger carry ledgerFallback(reserve): reserve - $0.002 +
// $0.001, never more than the reserve. Booking the reserve verbatim tripped
// caps one fee early on every Base image (audit round 3).
test("generate result includes a Cost line at the CHARGED price, not the catalog base or the reserve", async () => {
  const { call, budget } = makeHarness();
  const res = await call({ prompt: "a red cube", model: "openai/gpt-image-2", size: "1024x1024" });
  const text = res.content.map((c: any) => c.text).join("\n");
  assert.match(text, /Cost: \$0\.0640/); // 0.06 catalog x 1.05 + $0.001 observed (reserve is $0.065)
  assert.equal(res.structuredContent.cost_usd, 0.064);
  assert.equal(res.isError, undefined);
  assert.equal(budget.spent, 0.064, "the ledger books the observed charge, not the $0.065 reserve");
  assert.equal(networkCalls, 0, "the mocked ImageClient must be the only rail this suite touches");
});

test("large gpt-image-2 render is billed at the large-size CHARGED price", async () => {
  const { call } = makeHarness();
  const res = await call({ prompt: "wide banner", model: "openai/gpt-image-2", size: "1536x1024" });
  const text = res.content.map((c: any) => c.text).join("\n");
  assert.match(text, /Cost: \$0\.1270/); // reserve $0.128
  assert.equal(res.structuredContent.cost_usd, 0.127);
});

test("cheapest model (cogview-4) shows its own price", async () => {
  const { call } = makeHarness();
  const res = await call({ prompt: "a cat", model: "zai/cogview-4" });
  const text = res.content.map((c: any) => c.text).join("\n");
  assert.match(text, /Cost: \$0\.0168/); // the 2026-09-13 live quote: $0.016750 (booked as 0.016751, the reserve's ceil drift)
});

test("Base: the SDK call dropping mid-payment is booked and reported as a possible charge", async () => {
  // The SDK signs and sends the payment inside generate(); an abort out of it
  // is the paid retry (or its poll) that never answered. 0.50.0 never set the
  // in-flight flag on this rail at all, so this returned a plain "failed" with
  // $0 booked and the reservation released (audit round 3).
  const abort = new Error("This operation was aborted");
  abort.name = "AbortError";
  const original = fakeImageClient.generate;
  fakeImageClient.generate = async () => { throw abort; };
  try {
    const { call, budget } = makeHarness();
    const res = await call({ prompt: "a red cube", model: "openai/gpt-image-2", size: "1024x1024" });
    const text = res.content.map((c: any) => c.text).join("\n");
    assert.equal(res.isError, true);
    assert.match(text, /MAY have gone through/);
    assert.match(text, /action:"report"/);
    assert.doesNotMatch(text, /No payment was taken/);
    assert.equal(budget.spent, 0.064, "the observed charge is booked, and the reservation is released on top");
  } finally {
    fakeImageClient.generate = original;
  }
});

test("Base: an SDK API error (a response arrived) books nothing and is not a maybe", async () => {
  const original = fakeImageClient.generate;
  fakeImageClient.generate = async () => { throw new Error("API error 400: size not supported"); };
  try {
    const { call, budget } = makeHarness();
    const res = await call({ prompt: "a red cube", model: "openai/gpt-image-2", size: "1024x1024" });
    const text = res.content.map((c: any) => c.text).join("\n");
    assert.equal(res.isError, true);
    assert.doesNotMatch(text, /MAY have/);
    assert.equal(budget.spent, 0);
  } finally {
    fakeImageClient.generate = original;
  }
});

test("budget records the same amount that is reported to the user", async () => {
  const { call, budget } = makeHarness();
  const res = await call({ prompt: "a dog", model: "google/nano-banana" });
  // The CHARGED price, not the $0.05 catalog base and not the $0.054501
  // reserve: 0.05 * 1.05 + the observed $0.001 fee, ceiled to micro-USDC
  // exactly as the gateway does. Footer and ledger must agree on it — that is
  // what this test is for.
  assert.equal(budget.spent, 0.053501);
  assert.equal(res.structuredContent.cost_usd, 0.053501);
});

// The large-size tier was a single >1024 rule for every model, which is wrong for
// nano-banana-pro: probed live, it charges $0.107001 at BOTH 1024x1024 and
// 2048x2048 and only steps to $0.159500 at 4096x4096. A 2048 render therefore
// reserved AND booked the 4096 price (49% over), and on the Base path the
// estimate is written to the ledger verbatim as settled spend.
test("nano-banana-pro stays on the base price through 2048 and steps only at 4096", () => {
  const base = estimateCost("google/nano-banana-pro", "1024x1024");
  assert.equal(estimateCost("google/nano-banana-pro", "2048x2048"), base, "2048 must not be billed at the 4096 tier");
  assert.ok(estimateCost("google/nano-banana-pro", "4096x4096") > base, "4096 must step up");
  assert.equal(estimateCost("google/nano-banana-pro", "4096x4096"), 0.1595); // live quote
  assert.equal(base, 0.107001);                                             // live quote
});

test("nano-banana-2 bills its flat 1024 price and is accepted for edits", async () => {
  const { call } = makeHarness();
  const res = await call({ prompt: "a pear", model: "google/nano-banana-2" });
  const text = res.content.map((c: any) => c.text).join("\n");
  assert.match(text, /Cost: \$0\.0955/); // 0.09 catalog x 1.05 + $0.001 observed (reserve is $0.0965)
  assert.equal(res.isError, undefined);
  // Edit support: the gateway's EDIT_SUPPORTED_MODELS includes nano-banana-2,
  // so the local gate must not reject it before the paid call.
  const edit = await call({
    prompt: "make it red",
    action: "edit",
    model: "google/nano-banana-2",
    image: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  });
  assert.equal(edit.isError, undefined);
});

// Seedream's large tier is keyed on min(w,h), probed live: 2048x1024 and
// 1280x720 bill the $0.045 base while 2048x2048 bills $0.09. A max(w,h) rule
// gets one of the two 2048 sizes wrong whichever threshold it picks.
test("seedream-5-pro tiers on the smaller dimension", () => {
  const base = estimateCost("bytedance/seedream-5-pro", "1024x1024");
  assert.equal(base, 0.04925); // 0.045 catalog x 1.05 + $0.002
  assert.equal(estimateCost("bytedance/seedream-5-pro", "1280x720"), base);
  assert.equal(estimateCost("bytedance/seedream-5-pro", "2048x1024"), base, "2048x1024 is a base-tier size upstream");
  assert.equal(estimateCost("bytedance/seedream-5-pro", "2048x2048"), 0.0965, "2048x2048 is the $0.09 tier");
  assert.equal(estimateCost("bytedance/seedream-5-pro", "2848x1600"), 0.0965);
});

test("seedream-5-pro is rejected for edits before any charge", async () => {
  const { call, budget } = makeHarness();
  const res = await call({
    prompt: "make it red",
    action: "edit",
    model: "bytedance/seedream-5-pro",
    image: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  });
  assert.equal(res.isError, true);
  assert.equal(budget.spent, 0);
});

test("gpt-image-2 still steps above 1024", () => {
  const base = estimateCost("openai/gpt-image-2", "1024x1024");
  assert.ok(estimateCost("openai/gpt-image-2", "1536x1024") > base);
  assert.equal(base, 0.065);
});

test("a smaller-than-base render is never billed at the large tier", () => {
  assert.equal(estimateCost("google/nano-banana-pro", "512x512"), estimateCost("google/nano-banana-pro", "1024x1024"));
});
