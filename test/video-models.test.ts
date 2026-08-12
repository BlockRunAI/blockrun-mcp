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

// fetch is mocked to a SENTINEL throw rather than left unmocked. Every case here
// must be rejected before the network; a regressed gate then surfaces as the
// sentinel in the error text (asserted in errorText) instead of a real outbound
// POST to the paid endpoint. Leaving it unmocked had the same fail-loud property
// but made the suite network-bound — and made the "accepted" cases unwritable,
// which is exactly how the 30s window below went untested.
const sent: Array<Record<string, unknown>> = [];
mock.module("../src/utils/http.js", {
  namedExports: {
    fetchWithTimeout: async (_url: string, init?: { body?: string }) => {
      if (init?.body) sent.push(JSON.parse(init.body));
      throw new Error("NETWORK_ESCAPE");
    },
    isTimeoutError: () => false,
  },
});
mock.module("../src/utils/wallet.js", {
  namedExports: {
    getChain: () => "base",
    getOrCreateWalletKey: () => TEST_KEY,
    getWalletInfo: async () => ({ address: "0xTEST" }),
  },
});

const { registerVideoTool, estimateVideoCost, SEEDANCE_RESOLUTIONS } = await import("../src/tools/video.js");

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
  const text = res.content.map((c: any) => c.text).join("\n");
  assert.doesNotMatch(text, /NETWORK_ESCAPE/, `gate regressed — ${JSON.stringify(args)} reached the network`);
  return text;
}

/**
 * Let a call run all the way to the (mocked) network and return the JSON body it
 * would have POSTed. Asserting the estimate only proves what we RESERVE; this
 * proves what we SEND — the two diverge exactly where a parameter is supposed to
 * be dropped rather than forwarded.
 */
async function bodySentFor(args: Record<string, unknown>) {
  sent.length = 0;
  await makeHarness().call(args);
  assert.equal(sent.length, 1, `expected exactly one request for ${JSON.stringify(args)}`);
  return sent[0];
}

/**
 * Drive the handler for a case that must be ACCEPTED by the client-side gates,
 * and return the reserved estimate. A tiny budget makes the budget gate — which
 * sits after every guard and before any network call — report the number it was
 * asked to reserve, so "this combination is allowed, and for this much" is one
 * assertion. Without this, only rejections were testable.
 */
async function reservedFor(args: Record<string, unknown>) {
  const h = makeHarness();
  h.budget.limit = 0.0001;
  const res = await h.call(args);
  const text = res.content.map((c: any) => c.text).join("\n");
  assert.equal(res.isError, true, "expected the budget gate to stop this, not a guard");
  assert.doesNotMatch(text, /NETWORK_ESCAPE/, "must not reach the network");
  assert.match(text, /budget/i, `a guard rejected an allowed combination: ${text}`);
  // Return the ESTIMATE specifically. The message opens with the limit and the
  // remaining balance, so a bare /\$[\d.]+/ matches "$0.0001" on every call and
  // any price assertion built on it passes no matter what was reserved.
  const estimate = /next call estimated (\$[\d.]+)/.exec(text);
  assert.ok(estimate, `no estimate in budget message: ${text}`);
  return { text, estimate: estimate[1] };
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
  // mini rows probed 2026-08-12 (model added that day); each sits exactly the
  // $0.001 fee gap under the local reserve, same as every other row.
  ["bytedance/seedance-2.0-mini", undefined, undefined, 0.399554],
  ["bytedance/seedance-2.0-mini", 15, undefined, 1.196662],
  ["bytedance/seedance-2.0-mini", undefined, "480p", 0.200277],
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

test("image input is not discounted — the HANDLER reserves the same either way", async () => {
  // The old table gave Seedance 2.0 image jobs a 0.183/s "image tier" that does
  // not exist upstream (only video-to-video is cheaper), so image calls passed a
  // gate 40% too low. Live-confirmed 2026-08-07: the gateway quotes $1.13648 for
  // seedance-2.0 5s with AND without image_url. The bug lived in the handler, so
  // assert there — a unit call to estimateVideoCost cannot see image input at all.
  const { estimate: t2v } = await reservedFor({ prompt: "a cube", model: "bytedance/seedance-2.0", duration_seconds: 5 });
  assert.equal(t2v, "$1.14");
  for (const extra of [{ image_url: "https://example.com/a.png" }, { real_face_asset_id: "ta_abc123" }]) {
    const { estimate } = await reservedFor({ prompt: "a cube", model: "bytedance/seedance-2.0", duration_seconds: 5, ...extra });
    assert.equal(estimate, t2v, `image input changed the reserve (${JSON.stringify(extra)})`);
  }
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
  // Match the capability guard's own wording — /last_frame_url/ alone also
  // matches the two sibling guards, so it stayed green if the wrong one fired.
  assert.match(text, /does not support first-and-last-frame interpolation/);
  assert.match(text, /seedance-1\.5-pro/);
});

test("first-and-last-frame rejects its two invalid combinations", async () => {
  assert.match(
    await errorText({ prompt: "a cube", model: "bytedance/seedance-2.0", last_frame_url: "https://example.com/b.png" }),
    /requires image_url as the first frame/,
  );
  // NOTE: video.ts's third last_frame_url guard ("cannot be combined with
  // real_face_asset_id") is unreachable. Reaching it needs last_frame_url +
  // real_face_asset_id + image_url, and the RealFace block above rejects
  // image_url + real_face_asset_id first. Left in place as defence in depth
  // against a future reorder; pinned here so the real message is the one tested.
  assert.match(
    await errorText({ prompt: "a cube", model: "bytedance/seedance-2.0", image_url: "https://example.com/a.png", last_frame_url: "https://example.com/b.png", real_face_asset_id: "ta_abc123" }),
    /Pass exactly one of real_face_asset_id or image_url/,
  );
});

test("seedance-2.5 caps at 720p — 1080p is refused, not silently billed", async () => {
  const text = await errorText({ prompt: "a cube", model: "bytedance/seedance-2.5", resolution: "1080p" });
  assert.match(text, /caps at 720p/);
  assert.match(text, /seedance-2\.0/);
});

test("4K is refused on every model but seedance-2.0 — and 2.0 keeps it", async () => {
  for (const m of ["bytedance/seedance-2.0-fast", "bytedance/seedance-2.0-mini", "bytedance/seedance-1.5-pro", "bytedance/seedance-2.5"]) {
    assert.match(await errorText({ prompt: "a cube", model: m, resolution: "4K" }), /does not render 4K/, m);
  }
  // The other half, which had no coverage: narrowing the guard to reject 4K
  // everywhere would kill the flagship path and used to leave the suite green.
  const { text, estimate } = await reservedFor({ prompt: "a cube", model: "bytedance/seedance-2.0", resolution: "4K" });
  assert.equal(estimate, "$10.22", `4K must reserve the 9x factor: ${text}`);
});

test("off-schema resolutions are refused per model, in BOTH modes — with reachable inputs", async () => {
  // The load-bearing cases use ENUM-VALID values (1080p, 4K): a revert that
  // re-adds an image-conditioned wider set expressed in enum values is the
  // production-reachable "bill the tier, render 720p" trap, and mutation
  // testing showed the old 360p-only version missed it entirely.
  for (const args of [{}, { image_url: "https://example.com/a.png" }]) {
    assert.match(await errorText({ prompt: "a cube", model: "bytedance/seedance-2.0-fast", resolution: "1080p", ...args }), /does not render 1080p/);
    assert.match(await errorText({ prompt: "a cube", model: "bytedance/seedance-2.5", resolution: "1080p", ...args }), /does not render 1080p/);
    assert.match(await errorText({ prompt: "a cube", model: "bytedance/seedance-1.5-pro", resolution: "4K", ...args }), /does not render 4K/);
  }
  // The 2.0-fast note must point somewhere REAL. Anchored on the note's own
  // phrasing — a bare /seedance-2\.0/ was self-matching ("seedance-2.0-fast"
  // contains it), the fourth vacuous assertion this file has grown.
  const fast = await errorText({ prompt: "a cube", model: "bytedance/seedance-2.0-fast", resolution: "1080p" });
  assert.match(fast, /for 1080p use bytedance\/seedance-1\.5-pro/);
  // Defense-in-depth only: 360p left the zod enum in this release, so real MCP
  // callers get the enum error and never reach this guard message — the direct
  // handler call here pins the backstop for unvalidated invocation paths.
  assert.match(
    await errorText({ prompt: "a cube", model: "bytedance/seedance-2.0", resolution: "360p" }),
    /does not render 360p/,
  );
});

test("every schema-listed (model, resolution) pair is ACCEPTED — the whole table, positively", async () => {
  // Mutation testing proved the acceptance side was silently revertible:
  // emptying 2.0-fast's set left the suite green. The expected pairs are
  // HARDCODED here — iterating the exported table would test the mutation
  // against itself (a first draft of this test did exactly that and the same
  // two mutations still passed). This literal map IS the spec: token360's
  // published parameter schema, verified live 2026-08-07; 2.0-mini added
  // 2026-08-12 from the gateway registry's 2026-08-11 probe (480p/720p only)
  // and pinned against the live 402 the same day.
  const EXPECTED: Record<string, string[]> = {
    "bytedance/seedance-1.5-pro": ["480p", "720p", "1080p"],
    "bytedance/seedance-2.0-mini": ["480p", "720p"],
    "bytedance/seedance-2.0-fast": ["480p", "720p"],
    "bytedance/seedance-2.0": ["480p", "720p", "1080p", "4K"],
    "bytedance/seedance-2.5": ["480p", "720p"],
  };
  // The shipped table must equal the spec exactly — both directions.
  assert.deepEqual(
    Object.fromEntries(Object.entries(SEEDANCE_RESOLUTIONS).map(([m, s]) => [m, [...s.resolutions].sort()])),
    Object.fromEntries(Object.entries(EXPECTED).map(([m, r]) => [m, [...r].sort()])),
  );
  for (const [model, resolutions] of Object.entries(EXPECTED)) {
    for (const resolution of resolutions) {
      const { text } = await reservedFor({ prompt: "a cube", model, resolution });
      assert.doesNotMatch(text, /does not render/, `${model} must accept ${resolution}`);
      // Every accepted resolution must also be expressible by real callers and
      // priced by a real factor (estimateVideoCost throws on a missing one).
      assert.equal(makeHarness().config.inputSchema.resolution.parse(resolution), resolution);
      estimateVideoCost(model, 5, resolution);
    }
  }
});

test("resolution is ignored, not rejected, on the per-second models", async () => {
  // The schema promises "Ignored by xAI/Sora". Forwarding it earned a gateway
  // 400, and an earlier version of this guard rejected 4K on sora with a message
  // claiming it was "billed for 4K but downscales" — false for a per-second model.
  for (const m of ["azure/sora-2", "xai/grok-imagine-video"]) {
    const { text } = await reservedFor({ prompt: "a cube", model: m, resolution: "4K" });
    assert.doesNotMatch(text, /4K/, `${m} must ignore resolution, not reject it`);
    // "Ignored" has to mean not sent: forwarding it earned a gateway 400, so
    // asserting only that we did not reject it would miss the actual bug.
    const body = await bodySentFor({ prompt: "a cube", model: m, resolution: "4K", duration_seconds: 4 });
    assert.ok(!("resolution" in body), `${m} must not forward resolution: ${JSON.stringify(body)}`);
  }
  // ...and Seedance still gets it.
  const seedance = await bodySentFor({ prompt: "a cube", model: "bytedance/seedance-2.0", resolution: "1080p" });
  assert.equal(seedance.resolution, "1080p");
});

test("every resolution the schema accepts has a token factor — no silent 1x", () => {
  // `?? 1` used to price an unlisted tier at the 720p rate: a 9x under-reserve on
  // the most expensive call this server makes. It throws now; this pins that the
  // enum and the factor table cannot drift apart in the first place.
  const { config } = makeHarness();
  const base = estimateVideoCost("bytedance/seedance-2.0", 5, "720p");
  for (const r of ["480p", "720p", "1080p", "4K"]) {
    assert.equal(config.inputSchema.resolution.parse(r), r, `${r} must be in the enum`);
    if (r === "720p") continue;
    assert.notEqual(estimateVideoCost("bytedance/seedance-2.0", 5, r), base, `${r} prices at the 720p factor`);
  }
  assert.throws(() => estimateVideoCost("bytedance/seedance-2.0", 5, "8K"), /No token factor/);
  assert.throws(() => estimateVideoCost("bytedance/seedance-9.9", 5), /No price for video model/);
});

test("seedance-2.5 ACCEPTS 30s — the headline capability, asserted positively", async () => {
  // The previous version of this test called with 31 (out of range) and asserted
  // a regex that could not match under any implementation. Mutating the window
  // back to 4-15s left the whole suite green — the feature was silently
  // revertible. This asserts the accepted side, and pins the reserved price so a
  // 30s clip cannot quietly be reserved at the 5s default either.
  const { text, estimate } = await reservedFor({ prompt: "a cube", model: "bytedance/seedance-2.5", duration_seconds: 30 });
  assert.doesNotMatch(text, /supports 4-30s/, "30s must clear the duration window");
  assert.equal(estimate, "$9.47", `reserved the 30s price, not the 5s default: ${text}`);
});

test("durations outside each model's window are refused, both ends", async () => {
  // Upper bound, and the pointer to the model that can go longer.
  const over = await errorText({ prompt: "a cube", model: "bytedance/seedance-2.0", duration_seconds: 30 });
  assert.match(over, /supports 4-15s/);
  assert.match(over, /seedance-2\.5/);
  assert.match(
    await errorText({ prompt: "a cube", model: "bytedance/seedance-2.5", duration_seconds: 31 }),
    /bytedance\/seedance-2\.5 supports 4-30s — got duration_seconds=31/,
  );
  // Lower bound — every Seedance floor is 4s, and this half had no coverage at
  // all: deleting `billedSeconds < range.min ||` used to leave the suite green.
  for (const m of ["bytedance/seedance-1.5-pro", "bytedance/seedance-2.0", "bytedance/seedance-2.5"]) {
    assert.match(await errorText({ prompt: "a cube", model: m, duration_seconds: 3 }), /supports 4-\d+s — got duration_seconds=3/, m);
  }
  assert.match(await errorText({ prompt: "a cube", model: "xai/grok-imagine-video", duration_seconds: 16 }), /supports 1-15s/);
});

test("sora-2 pins its 4/8/12 allowlist — refused off it, accepted on it", async () => {
  assert.match(await errorText({ prompt: "a cube", model: "azure/sora-2", duration_seconds: 6 }), /exactly 4, 8, 12/);
  for (const s of [4, 8, 12]) {
    const { text } = await reservedFor({ prompt: "a cube", model: "azure/sora-2", duration_seconds: s });
    assert.doesNotMatch(text, /accepts duration_seconds of exactly/, `${s}s must be accepted`);
  }
});
