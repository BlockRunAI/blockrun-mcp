// Run with: npm test  (tsx --experimental-test-module-mocks --test)
//
// Two things this file pins, both of which cost real money when wrong:
//
//  1. estimateVideoCost must reserve the CHARGE. Every expected value below was
//     read off a LIVE 402 on 2026-08-07 (`npm run verify:prices`, which probes
//     for free), not derived from the same constants the estimator uses — a test
//     that recomputes the formula would have passed happily while all nine video
//     models under-reserved by the missing 5% margin.
//
//  2. The client-side capability gates. Seedance 2.5 doubles the length ceiling
//     (30s) but drops to 720p and supports neither RealFace nor first/last-frame.
//     token360 bills the resolution tier it was ASKED for even when it silently
//     downscales, so a wrong "yes" here is a charge for output you didn't get.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import type { BudgetState } from "../src/types.js";

const TEST_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

// No fetch mock: every case here must be rejected BEFORE the network. If a gate
// regresses, this throws on the real fetch instead of quietly passing.
mock.module("../src/utils/wallet.js", {
  namedExports: {
    getChain: () => "base",
    getOrCreateWalletKey: () => TEST_KEY,
    getWalletInfo: async () => ({ address: "0xTEST" }),
  },
});

const { registerVideoTool, estimateVideoCost } = await import("../src/tools/video.js");

function makeHarness() {
  let handler: ((args: Record<string, unknown>) => Promise<any>) | undefined;
  let config: any;
  const server = {
    registerTool: (_n: string, c: unknown, h: any) => { handler = h; config = c; },
    server: { getClientCapabilities: () => ({}) },
  } as any;
  const budget: BudgetState = { limit: null, spent: 0, calls: 0, agents: new Map() };
  registerVideoTool(server, budget);
  return { call: (args: Record<string, unknown>) => handler!(args), config, budget };
}

async function errorText(args: Record<string, unknown>) {
  const res = await makeHarness().call(args);
  assert.equal(res.isError, true, `expected a rejection for ${JSON.stringify(args)}`);
  return res.content.map((c: any) => c.text).join("\n");
}

// The residual is the repo-wide TRANSACTION_FEE_USD (0.002) still sitting above
// the gateway's current 0.001 fee — an over-reserve, the safe direction, and the
// subject of a separate sweep. Assert we never fall BELOW the live charge.
const LIVE_CHARGE: Array<[string, number | undefined, string | undefined, number]> = [
  ["xai/grok-imagine-video", undefined, undefined, 0.421001],
  ["azure/sora-2", undefined, undefined, 0.421001],
  ["bytedance/seedance-1.5-pro", undefined, undefined, 0.354916],
  ["bytedance/seedance-1.5-pro", 12, undefined, 0.850398],
  ["bytedance/seedance-1.5-pro", undefined, "480p", 0.177958],
  ["bytedance/seedance-2.0-fast", undefined, undefined, 0.826804],
  ["bytedance/seedance-2.0", undefined, undefined, 1.13648],
  ["bytedance/seedance-2.0", 15, undefined, 3.407439],
  ["bytedance/seedance-2.0", undefined, "1080p", 2.55583],
  ["bytedance/seedance-2.0", undefined, "4K", 10.220317],
  ["bytedance/seedance-2.5", undefined, undefined, 1.578875],
  ["bytedance/seedance-2.5", 30, undefined, 9.468246],
];

test("estimateVideoCost never reserves less than the gateway charged (live 402, 2026-08-07)", () => {
  for (const [model, seconds, resolution, charged] of LIVE_CHARGE) {
    const reserved = estimateVideoCost(model, seconds, resolution);
    assert.ok(
      reserved >= charged,
      `${model} ${seconds ?? "default"}s ${resolution ?? "720p"}: reserved ${reserved} < charged ${charged}`,
    );
    // ...and never by more than the known fee gap, so a stale rate can't hide
    // behind a generous cushion.
    assert.ok(
      reserved - charged <= 0.0011,
      `${model} ${seconds ?? "default"}s ${resolution ?? "720p"}: over-reserves by ${reserved - charged}`,
    );
  }
});

test("image input is not discounted — same reserve as text-to-video", () => {
  // The old table gave Seedance 2.0 image jobs a 0.183/s "image tier" that does
  // not exist upstream (only video-to-video is cheaper), so image calls passed a
  // gate 40% too low.
  assert.equal(estimateVideoCost("bytedance/seedance-2.0", 5), 1.13748);
});

test("seedance-2.5 is offered as a model", () => {
  const { config } = makeHarness();
  // Ask the schema, not its internals: zod's private shape moves between majors.
  assert.equal(config.inputSchema.model.parse("bytedance/seedance-2.5"), "bytedance/seedance-2.5");
  assert.throws(() => config.inputSchema.model.parse("bytedance/seedance-9.9"));
});

test("seedance-2.5 rejects RealFace assets before paying", async () => {
  const text = await errorText({
    prompt: "a person waving",
    model: "bytedance/seedance-2.5",
    real_face_asset_id: "ta_abc123",
  });
  assert.match(text, /does not support RealFace/);
  assert.match(text, /seedance-2\.0/);
});

test("seedance-2.5 rejects first-and-last-frame interpolation", async () => {
  const text = await errorText({
    prompt: "a cube",
    model: "bytedance/seedance-2.5",
    image_url: "https://example.com/a.png",
    last_frame_url: "https://example.com/b.png",
  });
  assert.match(text, /last_frame_url/);
});

test("seedance-2.5 caps at 720p — 1080p is refused, not silently billed", async () => {
  const text = await errorText({ prompt: "a cube", model: "bytedance/seedance-2.5", resolution: "1080p" });
  assert.match(text, /caps at 720p/);
  assert.match(text, /seedance-2\.0/);
});

test("4K is refused on every model but seedance-2.0", async () => {
  const text = await errorText({ prompt: "a cube", model: "bytedance/seedance-2.0-fast", resolution: "4K" });
  assert.match(text, /Only bytedance\/seedance-2\.0 renders true 4K/);
});

test("seedance-2.5 accepts 30s where 2.0 stops at 15s", async () => {
  const text = await errorText({ prompt: "a cube", model: "bytedance/seedance-2.0", duration_seconds: 30 });
  assert.match(text, /supports 4-15s/);
  assert.match(text, /seedance-2\.5/); // points at the model that can do it
  // 30s on 2.5 must get past the duration gate (it fails later, on the network).
  assert.doesNotMatch(
    await errorText({ prompt: "a cube", model: "bytedance/seedance-2.5", duration_seconds: 31 }),
    /supports 4-30s.*seedance-2\.5/s,
  );
});

test("sora-2 pins its 4/8/12 allowlist", async () => {
  const text = await errorText({ prompt: "a cube", model: "azure/sora-2", duration_seconds: 6 });
  assert.match(text, /exactly 4, 8, 12/);
});
