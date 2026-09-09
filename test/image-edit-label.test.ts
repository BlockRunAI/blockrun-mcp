// Run with: npm test  (tsx --experimental-test-module-mocks --test)
//
// blockrun_image edit reads whatever local file the model names — that is the
// documented feature ("edit ~/Downloads/photo.png") — base64s it into the
// request body and ships it to the gateway. The confirmSpend dialog is the one
// moment a human sees the call before it leaves the machine, and its label used
// to say only `image edit · <model>`: which file was about to leave was not on
// it. A prompt-injected reference to ~/Pictures/IMG_1234.jpg looked exactly like
// a normal $0.05 edit.
//
// Two properties are pinned here:
//   - the local branch resolves through fs.realpath, so the label carries the
//     REAL path — a symlink named innocently is shown as what it points at;
//   - the label lists every local source and the mask, and says nothing about
//     files for data: URIs or a plain generate.
// Nothing is restricted: cwd, tmpdir, home all still work. This is disclosure,
// not a sandbox.
process.env.BLOCKRUN_CONFIRM_SPEND = "on";
process.env.BLOCKRUN_CONFIRM_THRESHOLD = "0";

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { BudgetState } from "../src/types.js";

// Rail pin + traps, as in image-cost.test.ts. Every call below is DECLINED at
// the confirm dialog, so nothing past it may run — but the mocks make sure
// that if something did, it would fail here rather than pay.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "blockrun-image-label-"));
const realHome = process.env.HOME;
const savedApiKey = process.env.BLOCKRUN_API_KEY;
process.env.HOME = home;
delete process.env.BLOCKRUN_API_KEY;
process.on("exit", () => {
  if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
  if (savedApiKey === undefined) delete process.env.BLOCKRUN_API_KEY; else process.env.BLOCKRUN_API_KEY = savedApiKey;
  fs.rmSync(home, { recursive: true, force: true });
});

let networkCalls = 0;
const boom = () => { networkCalls++; throw new Error("UNEXPECTED_NETWORK_CALL"); };
mock.module("../src/utils/wallet.js", {
  namedExports: {
    getApiBase: () => "https://blockrun.ai/api",
    resolveGatewayUrl: (u: string) => u,
    getChain: () => "base",
    getImageClient: () => new Proxy({}, { get: () => boom }),
    getOrCreateWalletKey: () => { throw new Error("label tests must not touch a wallet key"); },
    getWalletInfo: async () => ({ address: "0xTEST" }),
    resolveSolanaKey: () => undefined,
  },
});
mock.module("../src/utils/http.js", {
  namedExports: { fetchWithTimeout: async () => boom(), isTimeoutError: () => false },
});

const { registerImageTool, toImageDataUri, resolveImageRef } = await import("../src/tools/image.js");

// 1x1 transparent PNG
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  "base64",
);
const DATA_URI = `data:image/png;base64,${PNG_BYTES.toString("base64")}`;

// Files live under a fresh tmp dir. On macOS os.tmpdir() is itself a symlink
// (/var -> /private/var), so realpath differs from the path we hand in — which
// is exactly the difference the label must show.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blockrun-img-label-"));
const photo = path.join(dir, "photo.png");
const logo = path.join(dir, "logo.jpg");
const maskFile = path.join(dir, "mask.png");
fs.writeFileSync(photo, PNG_BYTES);
fs.writeFileSync(logo, PNG_BYTES);
fs.writeFileSync(maskFile, PNG_BYTES);
const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), "blockrun-img-link-"));
const innocentLink = path.join(linkDir, "cat.png");
fs.symlinkSync(photo, innocentLink);
process.on("exit", () => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(linkDir, { recursive: true, force: true });
});
const real = (p: string) => fs.realpathSync(p);

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;

function harness() {
  let handler: Handler | undefined;
  const messages: string[] = [];
  const server = {
    registerTool: (_n: string, _c: unknown, h: Handler) => { handler = h; },
    server: {
      getClientCapabilities: () => ({ elicitation: {} }),
      elicitInput: async (req: { message: string }) => { messages.push(req.message); return { action: "decline" }; },
    },
  };
  const budget: BudgetState = { limit: null, spent: 0, calls: 0, agents: new Map() };
  registerImageTool(server as never, budget);
  assert.ok(handler, "blockrun_image did not register a handler");
  networkCalls = 0;
  return {
    call: async (args: Record<string, unknown>) => {
      const res = await handler!(args);
      return { res, text: res.content.map((p) => p.text ?? "").join("\n") };
    },
    budget,
    messages,
    // The confirm message's first line is "💸 BlockRun charge — <label>".
    label: () => {
      assert.equal(messages.length, 1, `expected one confirm dialog, got ${messages.length}`);
      return messages[0].split("\n")[0];
    },
  };
}

// --- resolveImageRef / toImageDataUri ---------------------------------------

test("resolveImageRef returns the data URI and the realpath for a local file", async () => {
  const out = await resolveImageRef(photo);
  assert.equal(out.dataUri, DATA_URI);
  assert.equal(out.localPath, real(photo));
});

test("resolveImageRef follows a symlink to its target and reports the TARGET", async () => {
  const out = await resolveImageRef(innocentLink);
  assert.equal(out.dataUri, DATA_URI);
  assert.equal(out.localPath, real(photo));
  assert.notEqual(out.localPath, innocentLink);
});

test("resolveImageRef reports no local path for a data: URI", async () => {
  const out = await resolveImageRef(DATA_URI);
  assert.equal(out.dataUri, DATA_URI);
  assert.equal(out.localPath, undefined);
});

test("toImageDataUri keeps its string contract (image.test.ts and callers depend on it)", async () => {
  assert.equal(await toImageDataUri(photo), DATA_URI);
  assert.equal(await toImageDataUri(DATA_URI), DATA_URI);
});

test("a missing local file still fails before any charge, naming the path", async () => {
  const h = harness();
  const { res, text } = await h.call({ prompt: "x", action: "edit", model: "google/nano-banana", image: path.join(dir, "nope.png") });
  assert.equal(res.isError, true);
  assert.match(text, /Could not load source image/);
  assert.match(text, /nope\.png/);
  assert.equal(h.messages.length, 0, "no confirm dialog for a request that cannot be built");
  assert.equal(h.budget.spent, 0);
});

// --- the confirmSpend label ---------------------------------------------------

test("edit label names the resolved local file that is about to leave the machine", async () => {
  const h = harness();
  const { res, text } = await h.call({ prompt: "make it red", action: "edit", model: "google/nano-banana", image: photo });
  assert.notEqual(res.isError, true, text);
  assert.match(text, /declined/i);
  assert.equal(h.label(), `💸 BlockRun charge — image edit · google/nano-banana · reads ${real(photo)}`);
  assert.equal(networkCalls, 0);
  assert.equal(h.budget.spent, 0);
});

test("edit label shows the symlink's TARGET, not the innocent name the model used", async () => {
  const h = harness();
  await h.call({ prompt: "make it red", action: "edit", model: "google/nano-banana", image: innocentLink });
  const label = h.label();
  assert.ok(label.endsWith(` · reads ${real(photo)}`), label);
  assert.ok(!label.includes(innocentLink), `the symlink path must not stand in for the file: ${label}`);
});

test("edit label lists every local source and the mask, in order", async () => {
  const h = harness();
  await h.call({ prompt: "fuse", action: "edit", model: "openai/gpt-image-2", image: photo, mask: maskFile });
  assert.equal(h.label(), `💸 BlockRun charge — image edit · openai/gpt-image-2 · reads ${real(photo)}, ${real(maskFile)}`);

  const h2 = harness();
  await h2.call({ prompt: "fuse", action: "edit", model: "google/nano-banana", image: [photo, DATA_URI, logo] });
  assert.equal(h2.label(), `💸 BlockRun charge — image edit · google/nano-banana · reads ${real(photo)}, ${real(logo)}`);
});

test("edit label carries no 'reads' when every input is a data URI", async () => {
  const h = harness();
  await h.call({ prompt: "make it red", action: "edit", model: "google/nano-banana", image: DATA_URI });
  assert.equal(h.label(), "💸 BlockRun charge — image edit · google/nano-banana");
});

test("generate label is unchanged", async () => {
  const h = harness();
  await h.call({ prompt: "a fox", model: "zai/cogview-4" });
  assert.equal(h.label(), "💸 BlockRun charge — image · zai/cogview-4");
});
