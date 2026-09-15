// Run with: npm test  (tsx --experimental-test-module-mocks --test)
//
// blockrun_image generate was dead on the Base wallet rail for every model and
// every prompt. The zod schema defaulted `quality` to "standard", the Base path
// hands that to @blockrun/llm's ImageClient.generate, whose body builder is
// `if (options?.quality) body.quality = options.quality` — "standard" is
// truthy — and since gateway commit 397e5d1c (live 2026-09-11) blockrun.ai's
// /v1/images/generations schema is `quality: z.enum(["low","medium","high",
// "xhigh","max","auto"]).optional()` AND refuses ANY quality value for every
// model this tool lists (only the two gpt-image-2.5 ids accept one). Unpaid
// probe 2026-09-13 (no payment header — a 402 means the body is accepted):
//
//   {model:"openai/gpt-image-2", prompt, size, quality:"standard"} -> HTTP 400
//       "Invalid option: expected one of low|medium|high|xhigh|max|auto"
//   same body without quality                                      -> HTTP 402
//   quality:"hd"                                                   -> HTTP 400 (same enum)
//   quality:"high"                                                 -> HTTP 400
//       "quality is not accepted for openai/gpt-image-2 ... Models that accept
//        it: openai/gpt-image-2.5-flare, openai/gpt-image-2.5-sunburst"
//
// Nothing was charged — the 400 precedes the 402 — but the tool answered
// "Image generation failed: API error: 400" with an altModels hint that fails
// identically. Solana and the account rail only survived because
// buildSolanaImageRequest drops "standard" on its own.
//
// The pin: there is NO quality parameter at all. Nothing the gateway accepts
// for these models can be expressed by it, so the schema neither defaults it
// nor declares it — a stale caller's value is stripped at the schema, the
// handler never reads one, and no rail's body carries the key. These tests go
// through the zod shape the way the MCP SDK does, because calling the handler
// directly (as the other image suites do) skips the schema entirely and could
// never have seen the original default.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import type { BudgetState } from "../src/types.js";

// Wallet/Base rail pin, as in image-cost.test.ts: a temp HOME so no account
// key on the developer's machine can switch the rail under the mocks.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "blockrun-image-quality-"));
const realHome = process.env.HOME;
const savedApiKey = process.env.BLOCKRUN_API_KEY;
process.env.HOME = home;
delete process.env.BLOCKRUN_API_KEY;
process.on("exit", () => {
  if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
  if (savedApiKey === undefined) delete process.env.BLOCKRUN_API_KEY; else process.env.BLOCKRUN_API_KEY = savedApiKey;
  fs.rmSync(home, { recursive: true, force: true });
});

const generateCalls: Array<{ prompt: string; options: Record<string, unknown> }> = [];
const fakeImageClient = {
  generate: async (prompt: string, options: Record<string, unknown>) => {
    generateCalls.push({ prompt, options });
    return { data: [{ url: "https://blockrun.ai/media/fake.png" }] };
  },
  edit: async () => ({ data: [{ url: "https://blockrun.ai/media/fake-edit.png" }] }),
};
mock.module("../src/utils/wallet.js", {
  namedExports: {
    getApiBase: () => "https://blockrun.ai/api",
    resolveGatewayUrl: (u: string) => u,
    getChain: () => "base",
    getImageClient: () => fakeImageClient,
    getOrCreateWalletKey: () => "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    getWalletInfo: async () => ({ address: "0xTEST" }),
    resolveSolanaKey: () => undefined,
  },
});
let networkCalls = 0;
mock.module("../src/utils/http.js", {
  namedExports: {
    fetchWithTimeout: async () => { networkCalls++; throw new Error("network call escaped the mocks"); },
    isTimeoutError: () => false,
  },
});

const { registerImageTool, buildSolanaImageRequest } = await import("../src/tools/image.js");

function makeHarness() {
  let handler: ((args: Record<string, unknown>) => Promise<any>) | undefined;
  let shape: z.ZodRawShape | undefined;
  const server = {
    registerTool: (_name: string, cfg: { inputSchema: z.ZodRawShape }, h: any) => { handler = h; shape = cfg.inputSchema; },
    server: { getClientCapabilities: () => ({}) },
  } as any;
  const budget: BudgetState = { limit: null, spent: 0, calls: 0, agents: new Map() };
  registerImageTool(server, budget);
  assert.ok(handler && shape, "blockrun_image did not register");
  // What the MCP SDK hands the handler: the shape parsed with its defaults.
  const parse = (args: Record<string, unknown>) => z.object(shape!).parse(args) as Record<string, unknown>;
  return { call: (args: Record<string, unknown>) => handler!(args), parse, budget, shape: shape! };
}

test("the schema does not invent a quality: a call without one parses to quality undefined", () => {
  const { parse } = makeHarness();
  const parsed = parse({ prompt: "a cat" });
  assert.equal(parsed.quality, undefined, `zod filled quality=${JSON.stringify(parsed.quality)} — the gateway 400s "standard"`);
  // Defaults that DO exist still apply, so this is the right parse path.
  assert.equal(parsed.action, "generate");
  assert.equal(parsed.size, "1024x1024");
});

test("Base rail: the default generate call reaches the SDK with NO quality option (the SDK forwards any truthy value)", async () => {
  const { call, parse } = makeHarness();
  const res = await call(parse({ prompt: "a cat" }));
  assert.equal(res.isError, undefined, res.content?.map((c: any) => c.text).join("\n"));
  assert.equal(generateCalls.length, 1);
  assert.equal(generateCalls[0].options.quality, undefined,
    `the Base SDK path would send body.quality=${JSON.stringify(generateCalls[0].options.quality)}, which blockrun.ai rejects 400 for every listed model`);
  assert.equal(generateCalls[0].options.model, "openai/gpt-image-2");
  assert.equal(networkCalls, 0);
});

test("Solana and account rails: the body builder puts no quality on the wire for the default call", () => {
  const { parse } = makeHarness();
  const parsed = parse({ prompt: "a fox", model: "google/nano-banana" });
  const { body } = buildSolanaImageRequest("generate", {
    model: parsed.model as string,
    prompt: parsed.prompt as string,
    size: parsed.size as string,
  });
  assert.equal("quality" in body, false, `body carries quality=${JSON.stringify(body.quality)}`);
  assert.deepEqual(body, { model: "google/nano-banana", prompt: "a fox", size: "1024x1024", n: 1 });
});

test("the schema declares no quality at all: a stale caller's value is stripped and never reaches the SDK", async () => {
  // Every explicit value — "standard", "hd", "high" — is refused by the
  // gateway before payment for every listed model, so keeping the parameter
  // would only let a caller turn a paid call into a 400. It is gone from the
  // schema (zod strips the unknown key) and from the handler.
  const { call, parse, shape } = makeHarness();
  assert.equal("quality" in shape, false, "blockrun_image still declares a quality parameter");
  for (const quality of ["standard", "hd", "high"]) {
    generateCalls.length = 0;
    const parsed = parse({ prompt: "a cat", quality });
    assert.equal("quality" in parsed, false, `zod let quality=${quality} through`);
    const res = await call(parsed);
    assert.equal(res.isError, undefined, res.content?.map((c: any) => c.text).join("\n"));
    assert.equal(generateCalls.length, 1);
    assert.equal("quality" in generateCalls[0].options, false, `the Base SDK path would send quality=${quality}`);
  }
  // And a handler called DIRECTLY with the key (no schema in front, as an
  // in-process caller might) still forwards nothing.
  generateCalls.length = 0;
  const res = await call({ prompt: "a cat", quality: "hd" });
  assert.equal(res.isError, undefined);
  assert.equal("quality" in generateCalls[0].options, false, "the handler read a quality it does not declare");
});
