// Seedance reference media: the ACCOUNT rail, where it is the only rail that
// serves it and the only rail with no 402 to correct a bad estimate.
//
// Why this file exists separately from video-models.test.ts: that suite is
// pinned to the Base rail (getChain: () => "base", no auth mock), and every
// reference request is refused there by design. The interesting surface — the
// body that is forwarded, and the reserve that is held before an unquoted,
// billed-at-submit POST — only exists behind BLOCKRUN_API_KEY.
//
// Three properties are pinned here, each of which was wrong before:
//   1. The reserve prices reference clips per reference SECOND at the model's
//      ceiling, the way the gateway does (blockrun#730). The count-based term
//      it replaces under-reserved 2-3.2x, and on this rail a reserve that is
//      too low means the budget cap admits a job it cannot pay for.
//   2. Reference media is REFUSED before any network call on both wallet rails.
//   3. Every capability guard fires for its off-model input, still with nothing
//      on the wire.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import type { BudgetState } from "../src/types.js";

const TEST_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

// The SSRF resolver, driven by a hostname set rather than stubbed flat: the
// reference fields are the only place 36 caller URLs reach it, and the wallet
// rail refuses them before the loop, so this file is the only place their DNS
// policy can be tested at all. `resolved` records the order and multiplicity of
// lookups, which is how host dedup is asserted.
const blockedHosts = new Set<string>();
const resolved: string[] = [];
mock.module("../src/utils/ssrf.js", {
  namedExports: {
    isBlockedFetchHostResolved: async (host: string) => {
      resolved.push(host);
      return blockedHosts.has(host);
    },
  },
});

// Rail switches. Flipped per test, read through the mocked accessors below.
let apiKeyMode = true;
let activeChain: "base" | "solana" = "base";

// As in video-models: a SENTINEL throw, so a guard that regresses shows up as
// the sentinel in the error text instead of a real POST to a paid endpoint.
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
mock.module("../src/utils/auth.js", {
  namedExports: {
    isApiKeyMode: () => apiKeyMode,
    getAuthMode: () => (apiKeyMode ? "api-key" : "wallet"),
    getApiKey: () => (apiKeyMode ? "br_test" : undefined),
    getApiKeyBase: () => "https://api.blockrun.ai",
    apiAuthHeaders: () => (apiKeyMode ? { Authorization: "Bearer br_test" } : {}),
    requireWalletMode: (c: string) => `${c} needs wallet mode`,
    resetAuthCache: () => {},
    DEFAULT_API_KEY_BASE: "https://api.blockrun.ai",
    PORTAL_URL: "https://user.blockrun.ai",
    PORTAL_KEYS_URL: "https://user.blockrun.ai/dashboard/keys",
    PORTAL_CREDITS_URL: "https://user.blockrun.ai/dashboard/credits",
    PORTAL_ACTIVITY_URL: "https://user.blockrun.ai/dashboard/activity",
  },
});
mock.module("../src/utils/onramp.js", {
  namedExports: { launchTopUp: async () => ({ opened: false, url: "", note: "" }) },
});
mock.module("../src/utils/wallet.js", {
  namedExports: {
    getApiBase: () => "https://api.blockrun.ai",
    resolveGatewayUrl: (u: string) => (u.startsWith("http") ? u : `https://blockrun.ai/api${u.startsWith("/api/") ? u.slice(4) : u}`),
    getChain: () => activeChain,
    getOrCreateWalletKey: () => TEST_KEY,
    getWalletInfo: async () => ({ address: "0xTEST" }),
    resolveSolanaKey: () => undefined,
  },
});

const { registerVideoTool, estimateVideoCost } = await import("../src/tools/video.js");

function makeHarness() {
  let handler: ((args: Record<string, unknown>) => Promise<any>) | undefined;
  const server = {
    registerTool: (_n: string, _c: unknown, h: any) => { handler = h; },
    server: { getClientCapabilities: () => ({}) },
  } as any;
  const budget: BudgetState = { limit: null, spent: 0, calls: 0, agents: new Map() };
  registerVideoTool(server, budget);
  return { call: (args: Record<string, unknown>) => handler!(args), budget };
}

async function errorText(args: Record<string, unknown>) {
  const res = await makeHarness().call(args);
  assert.equal(res.isError, true, `expected a rejection for ${JSON.stringify(args)}`);
  const text = res.content.map((c: any) => c.text).join("\n");
  assert.doesNotMatch(text, /NETWORK_ESCAPE/, `gate regressed — ${JSON.stringify(args)} reached the network`);
  return text;
}

async function bodySentFor(args: Record<string, unknown>) {
  sent.length = 0;
  await makeHarness().call(args);
  assert.equal(sent.length, 1, `expected exactly one request for ${JSON.stringify(args)}`);
  return sent[0];
}

const IMG = "https://example.com/character.png";
const VID = "https://example.com/motion.mp4";
const AUD = "https://example.com/score.mp3";

// ---------------------------------------------------------------------------
// 1. The reserve
// ---------------------------------------------------------------------------

// The gateway's arithmetic, transcribed: tokens = output seconds x the model's
// per-second rate x the resolution factor, PLUS every reference clip at the
// 15.2s ceiling x 21,600 tokens/s (audio at 0.3x), with the reference term's
// resolution factor floored at 1. Reserve must never fall below it.
const REFERENCE_CHARGE: Array<[string, number, number, number, string | undefined, number]> = [
  // model, outputSeconds, videos, audios, resolution, gateway charge (no tx fee)
  ["bytedance/seedance-2.0", 5, 1, 0, "720p", 4.573015],
  ["bytedance/seedance-2.0", 5, 0, 1, "720p", 2.166740],
  ["bytedance/seedance-2.0", 5, 3, 3, "720p", 14.541866],
  ["bytedance/seedance-2.0-mini", 5, 1, 0, "720p", 1.605130],
  ["bytedance/seedance-2.0-mini", 4, 3, 3, "720p", 5.024489],
  // 480p: the reference term does NOT scale down — 21,600 was measured at 720p
  // and scaling below it would bill under the only rate ever probed. Honest
  // label: unlike the rows above, this figure is what the FLOOR produces, not
  // an independently observed charge. blockrun#730 measured at 720p only, and
  // neither wallet gateway will quote reference media, so no probe from this
  // repo can confirm it. It pins the floor against removal, not against
  // upstream. The gateway's referenceTokens() applies the same Math.max(rf, 1),
  // so the two agree by construction.
  ["bytedance/seedance-2.0-mini", 5, 1, 0, "480p", 1.405853],
];

test("the reserve covers the gateway's per-reference-second charge on every probed combination", () => {
  for (const [model, seconds, videos, audios, resolution, charged] of REFERENCE_CHARGE) {
    const reserved = estimateVideoCost(model, seconds, resolution, { videos, audios });
    assert.ok(reserved >= charged, `${model} ${seconds}s v${videos}/a${audios} ${resolution}: reserved ${reserved} < charged ${charged}`);
    // ...and only by the known transaction-fee gap, so the ceiling assumption
    // cannot hide a stale rate behind a generous cushion.
    assert.ok(reserved - charged <= 0.0021, `${model} ${seconds}s v${videos}/a${audios}: over-reserves by ${reserved - charged}`);
  }
});

test("a reference clip costs the same whatever the OUTPUT length — the bug the count-based term had", () => {
  // The replaced formula multiplied the surcharge by the render duration, so a
  // 4s render with a 15.2s clip reserved a quarter of what it owed. The clip's
  // price depends on the CLIP, and the caller never declares its length, so it
  // is quoted at the ceiling and is flat across output durations.
  const m = "bytedance/seedance-2.0";
  const deltas = [4, 5, 10, 15].map(sec =>
    estimateVideoCost(m, sec, "720p", { videos: 1 }) - estimateVideoCost(m, sec, "720p"));
  for (const d of deltas) {
    assert.ok(Math.abs(d - deltas[0]) < 1e-6, `reference surcharge moved with output duration: ${deltas.join(", ")}`);
  }
  assert.ok(deltas[0] > 3.4, `a 15.2s reference clip on 2.0 costs ~$3.44, got ${deltas[0]}`);
});

test("reference counts scale linearly and audio is exactly 0.3 of video", () => {
  const m = "bytedance/seedance-2.0";
  const plain = estimateVideoCost(m, 5, "720p");
  const oneVideo = estimateVideoCost(m, 5, "720p", { videos: 1 }) - plain;
  const oneAudio = estimateVideoCost(m, 5, "720p", { audios: 1 }) - plain;
  // Tolerance is a millionth of a dollar, not an epsilon: these are USD deltas
  // that have been through withTxFee's rounding, so exact equality is the wrong
  // question — "the same to well under a cent" is the one that matters.
  assert.ok(Math.abs(oneAudio / oneVideo - 0.3) < 1e-6, `audio factor is ${oneAudio / oneVideo}, not 0.3`);
  for (const n of [2, 3]) {
    const many = estimateVideoCost(m, 5, "720p", { videos: n }) - plain;
    assert.ok(Math.abs(many - n * oneVideo) < 1e-6, `${n} clips is not ${n}x one clip`);
  }
  assert.equal(estimateVideoCost(m, 5, "720p", {}), plain, "an empty references object must price as no references");
  assert.equal(estimateVideoCost(m, 5, "720p", { videos: 0, audios: 0 }), plain, "explicit zeros must price as no references");
});

test("an out-of-range or non-integer reference count throws rather than reserving a guessed rate", () => {
  const m = "bytedance/seedance-2.0";
  for (const bad of [{ videos: 4 }, { audios: 4 }, { videos: -1 }, { audios: -1 }, { videos: 1.5 }, { audios: NaN }]) {
    assert.throws(() => estimateVideoCost(m, 5, "720p", bad), /Invalid reference counts/, JSON.stringify(bad));
  }
});

test("references against a model with no token price throw instead of being silently dropped", () => {
  // The validation used to live INSIDE the Seedance branch, so grok and sora
  // fell through to their own per-second tables and the references vanished
  // from the reserve without a word — the exact fail-open the estimator's
  // throw-never-default rule exists to prevent.
  for (const model of ["xai/grok-imagine-video", "azure/sora-2"]) {
    assert.throws(() => estimateVideoCost(model, 8, undefined, { videos: 1 }), /not token-priced/, model);
  }
  // With no references those models still price normally.
  assert.ok(estimateVideoCost("xai/grok-imagine-video", 8) > 0);
});

// ---------------------------------------------------------------------------
// 2. Rail availability
// ---------------------------------------------------------------------------

test("reference media is refused BEFORE any network call on both wallet rails", async () => {
  apiKeyMode = false;
  try {
    for (const chain of ["base", "solana"] as const) {
      activeChain = chain;
      for (const args of [
        { reference_image_urls: [IMG] },
        { reference_videos: [{ url: VID }] },
        { reference_audios: [{ url: AUD }], reference_image_urls: [IMG] },
      ]) {
        const text = await errorText({ prompt: "a cube", model: "bytedance/seedance-2.0", ...args });
        assert.match(text, /served only by the BlockRun account rail/, `${chain}: ${text}`);
        assert.match(text, /api\.blockrun\.ai/, text);
        // The refusal must never read as a money event: nothing was sent.
        assert.match(text, /No payment was taken/, text);
      }
    }
  } finally {
    apiKeyMode = true;
    activeChain = "base";
  }
});

test("frame seeding still works on the wallet rails — only reference media is account-only", async () => {
  apiKeyMode = false;
  try {
    const body = await bodySentFor({ prompt: "a cube", model: "bytedance/seedance-2.5", image_url: IMG, last_frame_url: "https://example.com/b.png" });
    assert.equal(body.last_frame_url, "https://example.com/b.png");
  } finally {
    apiKeyMode = true;
  }
});

// ---------------------------------------------------------------------------
// 3. The account rail: what is forwarded, and what is reserved
// ---------------------------------------------------------------------------

test("the account rail forwards every reference field and output control verbatim", async () => {
  const args = {
    prompt: "Use image 1 for the character and video 1 for the motion",
    model: "bytedance/seedance-2.0-mini",
    duration_seconds: 5,
    reference_image_urls: [IMG],
    reference_videos: [{ url: VID }],
    reference_audios: [{ url: AUD }],
    bitrate_mode: "high",
    return_last_frame: true,
    safety_identifier: "end-user-42",
    input_type: "reference",
  };
  const body = await bodySentFor(args);
  for (const field of ["reference_image_urls", "reference_videos", "reference_audios", "bitrate_mode", "return_last_frame", "safety_identifier", "input_type"] as const) {
    assert.deepEqual(body[field], args[field], field);
  }
});

test("the account rail reserves the ceiling-priced surcharge before submitting", async () => {
  // This rail bills when the gateway ACCEPTS the job and offers no quote, so
  // the gate below is the only thing standing between a reference job and a
  // budget cap. A limit just under the true price must refuse it.
  const args = {
    prompt: "t", model: "bytedance/seedance-2.0-mini", duration_seconds: 5,
    reference_videos: [{ url: VID }], reference_image_urls: [IMG],
  };
  const expected = estimateVideoCost("bytedance/seedance-2.0-mini", 5, undefined, { videos: 1 });
  assert.ok(expected > 1.6, `the ceiling-priced reserve should be ~$1.61, got ${expected}`);

  const h = makeHarness();
  h.budget.limit = expected - 0.01;
  const res = await h.call({ ...args, agent_id: undefined });
  const text = res.content.map((c: any) => c.text).join("\n");
  assert.equal(res.isError, true, "a budget below the true reference price must refuse");
  assert.doesNotMatch(text, /NETWORK_ESCAPE/, "refused calls must not reach the network");
  assert.match(text, /budget/i, text);
  const shown = /next call estimated \$([\d.]+)/.exec(text);
  assert.ok(shown, `no estimate in budget message: ${text}`);
  assert.ok(Math.abs(Number(shown[1]) - expected) < 0.01, `reserved ${shown[1]}, expected ~${expected}`);
});

test("reference IMAGES carry no surcharge — the gateway prices only clips", async () => {
  // calculateVideoPrice upstream takes { videoSeconds, audioSeconds } and
  // nothing else; reference images only flip the i2v classification, which on
  // Seedance is the same per-second rate. Reserving extra for them would
  // refuse jobs the gateway would have served.
  const withImages = estimateVideoCost("bytedance/seedance-2.5", 5, "720p", {});
  const plain = estimateVideoCost("bytedance/seedance-2.5", 5, "720p");
  assert.equal(withImages, plain);
  const body = await bodySentFor({ prompt: "t", model: "bytedance/seedance-2.5", duration_seconds: 5, reference_image_urls: Array(30).fill(IMG) });
  assert.equal((body.reference_image_urls as string[]).length, 30);
});

// ---------------------------------------------------------------------------
// 4. Every guard, every branch
// ---------------------------------------------------------------------------

test("every capability guard fires for its off-model input, and none reaches the network", async () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    // reference images: wrong model, and over the per-model count
    [{ model: "bytedance/seedance-1.5-pro", reference_image_urls: [IMG] }, /does not accept reference images/],
    [{ model: "xai/grok-imagine-video", reference_image_urls: [IMG] }, /does not accept reference images/],
    [{ model: "azure/sora-2", reference_image_urls: [IMG] }, /does not accept reference images/],
    [{ model: "bytedance/seedance-2.0", reference_image_urls: Array(10).fill(IMG) }, /at most 9 reference images — got 10/],
    [{ model: "bytedance/seedance-2.0-fast", reference_image_urls: Array(10).fill(IMG) }, /at most 9 reference images/],
    // reference clips: 2.5 takes images but no clips
    [{ model: "bytedance/seedance-2.5", reference_videos: [{ url: VID }] }, /does not accept reference video or audio/],
    [{ model: "bytedance/seedance-2.5", reference_audios: [{ url: AUD }], reference_image_urls: [IMG] }, /2\.5 takes reference IMAGES/],
    [{ model: "bytedance/seedance-1.5-pro", reference_videos: [{ url: VID }] }, /does not accept reference video or audio/],
    [{ model: "xai/grok-imagine-video", reference_videos: [{ url: VID }] }, /does not accept reference video or audio/],
    // audio needs visual conditioning
    [{ model: "bytedance/seedance-2.0", reference_audios: [{ url: AUD }] }, /requires a reference image or video/],
    // references never combine with frame seeds
    [{ model: "bytedance/seedance-2.0", reference_image_urls: [IMG], image_url: IMG }, /cannot be combined with frame seeds/],
    [{ model: "bytedance/seedance-2.0", reference_image_urls: [IMG], real_face_asset_id: "ta_abc123" }, /cannot be combined with frame seeds/],
    [{ model: "bytedance/seedance-2.0", reference_image_urls: [IMG], image_url: IMG, last_frame_url: IMG }, /cannot be combined with frame seeds/],
    // output controls, each named in its own refusal
    [{ model: "bytedance/seedance-1.5-pro", bitrate_mode: "high" }, /bitrate_mode requires a Seedance 2\.x model/],
    [{ model: "xai/grok-imagine-video", bitrate_mode: "high" }, /bitrate_mode requires a Seedance 2\.x model/],
    [{ model: "bytedance/seedance-2.0", output_format: "mov" }, /output_format requires bytedance\/seedance-2\.5/],
    [{ model: "bytedance/seedance-2.0", seed: 1 }, /seed requires bytedance\/seedance-1\.5-pro/],
    [{ model: "bytedance/seedance-2.5", camera_fixed: true }, /camera_fixed requires bytedance\/seedance-1\.5-pro/],
    [{ model: "xai/grok-imagine-video", watermark: false }, /watermark requires a Seedance model/],
    [{ model: "azure/sora-2", return_last_frame: true }, /return_last_frame requires a Seedance model/],
    [{ model: "xai/grok-imagine-video", safety_identifier: "x" }, /safety_identifier requires a Seedance model/],
    // input_type is a cross-check, and says what it expected
    [{ model: "bytedance/seedance-2.0", input_type: "reference" }, /expected "text"/],
    [{ model: "bytedance/seedance-2.0", image_url: IMG, input_type: "text" }, /expected "image"/],
    [{ model: "bytedance/seedance-2.0", image_url: IMG, last_frame_url: IMG, input_type: "image" }, /expected "first_last_frame"/],
    [{ model: "bytedance/seedance-2.0", reference_image_urls: [IMG], input_type: "image" }, /expected "reference"/],
  ];
  for (const [args, re] of cases) {
    const text = await errorText({ prompt: "t", ...args });
    assert.match(text, re, JSON.stringify(args));
    // A pre-payment refusal must never be dressed as a failed render: that is
    // what the catch-all's "Video generation failed" prefix (and its "try
    // seedance-2.0 or sora-2" advice) would have said for a request that never
    // left the machine.
    assert.doesNotMatch(text, /Video generation failed/, JSON.stringify(args));
  }
});

test("the accepted twins at each boundary still go through", async () => {
  assert.equal(((await bodySentFor({ prompt: "t", model: "bytedance/seedance-2.0", reference_image_urls: Array(9).fill(IMG) })).reference_image_urls as string[]).length, 9);
  assert.equal(((await bodySentFor({ prompt: "t", model: "bytedance/seedance-2.5", reference_image_urls: Array(30).fill(IMG) })).reference_image_urls as string[]).length, 30);
  for (const model of ["bytedance/seedance-2.0", "bytedance/seedance-2.0-fast", "bytedance/seedance-2.0-mini"]) {
    const body = await bodySentFor({ prompt: "t", model, reference_videos: [{ url: VID }], reference_audios: [{ url: AUD }] });
    assert.deepEqual(body.reference_videos, [{ url: VID }], model);
  }
  // Each input_type value is accepted when it agrees with the inputs.
  for (const [args, value] of [
    [{}, "text"],
    [{ image_url: IMG }, "image"],
    [{ image_url: IMG, last_frame_url: IMG }, "first_last_frame"],
    [{ reference_image_urls: [IMG] }, "reference"],
  ] as const) {
    const body = await bodySentFor({ prompt: "t", model: "bytedance/seedance-2.0", ...args, input_type: value });
    assert.equal(body.input_type, value);
  }
});

// ---------------------------------------------------------------------------
// 5. SSRF across the new URL arrays
// ---------------------------------------------------------------------------

test("a private host anywhere in a reference array is caught, and the message names the field", async () => {
  blockedHosts.add("169.254.169.254");
  try {
    for (const [args, field] of [
      [{ reference_image_urls: [IMG, IMG, "http://169.254.169.254/portrait.png"] }, "reference_image_urls"],
      [{ reference_videos: [{ url: VID }, { url: "https://169.254.169.254/motion.mp4" }] }, "reference_videos"],
      [{ reference_image_urls: [IMG], reference_audios: [{ url: AUD }, { url: "https://169.254.169.254/x.mp3" }] }, "reference_audios"],
    ] as const) {
      // A public first element must not shield the rest: a regression to
      // checking only [0] passes every single-element case.
      const text = await errorText({ prompt: "t", model: "bytedance/seedance-2.0", ...args });
      assert.match(text, /private\/loopback\/link-local/, JSON.stringify(args));
      assert.match(text, new RegExp(field), `the refusal must name the offending field, got: ${text}`);
    }
  } finally {
    blockedHosts.delete("169.254.169.254");
  }
});

test("a non-http(s) scheme in a reference array is refused and names its field", async () => {
  const text = await errorText({ prompt: "t", model: "bytedance/seedance-2.0", reference_image_urls: [IMG], reference_audios: [{ url: "file:///etc/music.mp3" }] });
  assert.match(text, /must be an http\(s\) URL/);
  assert.match(text, /reference_audios/);
});

test("one DNS resolution per HOST, not per URL", async () => {
  // 30 images on one CDN used to be 30 identical getaddrinfo calls on libuv's
  // 4-thread pool, awaited one at a time, before the call had earned anything.
  resolved.length = 0;
  await bodySentFor({
    prompt: "t", model: "bytedance/seedance-2.5",
    reference_image_urls: Array(30).fill("https://cdn.example.com/a.png"),
  });
  assert.deepEqual(resolved, ["cdn.example.com"], `resolved ${resolved.length} times for one host`);
});

test("a bad resolution or duration is also refused before any DNS work", async () => {
  // Same principle as the guard block above: every purely in-memory check now
  // sits ahead of the resolver, so no caller-chosen hostname is looked up for
  // a request the tool was always going to refuse.
  resolved.length = 0;
  await errorText({ prompt: "t", model: "bytedance/seedance-2.5", resolution: "4K", image_url: "https://attacker.example.com/a.png" });
  assert.deepEqual(resolved, [], "a rejected resolution still resolved a hostname");
  await errorText({ prompt: "t", model: "bytedance/seedance-2.0", duration_seconds: 99, image_url: "https://attacker.example.com/a.png" });
  assert.deepEqual(resolved, [], "a rejected duration still resolved a hostname");
});

test("an unsupported combination is refused BEFORE any DNS work", async () => {
  // The guards used to sit below the resolver, so a model that rejects
  // reference images outright still paid for every lookup first — a free,
  // unbilled, ledger-invisible outbound DNS query per caller-chosen hostname.
  resolved.length = 0;
  await errorText({
    prompt: "t", model: "xai/grok-imagine-video",
    reference_image_urls: Array(30).fill("https://attacker.example.com/a.png"),
  });
  assert.deepEqual(resolved, [], `${resolved.length} hostnames were resolved for a request the tool always refuses`);
});

test("the rail refusal is answered before every other guard", async () => {
  // Ranked below the frame-seed guards, a wallet-rail reference request that
  // also carried last_frame_url cost three round trips: "add image_url", then
  // "frame seeds and references do not mix", then finally the rail fact that
  // made all of it moot.
  apiKeyMode = false;
  try {
    for (const args of [
      { model: "bytedance/seedance-2.5", reference_image_urls: [IMG], last_frame_url: IMG },
      { model: "bytedance/seedance-2.0", reference_image_urls: [IMG], real_face_asset_id: "ta_abc123" },
      { model: "xai/grok-imagine-video", reference_image_urls: [IMG], image_url: IMG },
      // Even a combination that is invalid for other reasons answers the rail
      // first, because no rail change can make the rest matter.
      { model: "bytedance/seedance-2.0", reference_image_urls: Array(99).fill(IMG), output_format: "mov" },
    ]) {
      const text = await errorText({ prompt: "t", ...args });
      assert.match(text, /served only by the BlockRun account rail/, JSON.stringify(args));
    }
  } finally {
    apiKeyMode = true;
  }
});
