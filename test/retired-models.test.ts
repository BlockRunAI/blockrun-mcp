// Run with: npm test  (tsx --test)
//
// Provider retirements the gateways answer with a REDIRECT (owner-approved
// 2026-11-24). A redirect is silent by design: the gateway rewrites the model
// id before it prices or routes, so a stale id here never errors — it quietly
// settles as another model at another price. Two things therefore have to hold
// for every redirected id, and neither surfaces on its own:
//
//   1. No routing tier sends traffic to it. A tier member is a choice this
//      server makes for the caller; naming a model that is no longer served is
//      choosing one the caller never sees.
//   2. An explicit pin still reserves enough, whichever rail answers it and in
//      whichever order the gateways ship the redirect: at least the successor's
//      rate (what a redirected call is quoted) AND at least the rate the
//      catalogues list for the old id until then.
import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateChatCost } from "../src/tools/chat.js";
import {
  MODEL_TIERS,
  CHAT_PRICE_PER_MTOKEN,
  DEFAULT_CHAT_PRICE,
  canonicalChatModel,
} from "../src/utils/constants.js";

type Rate = { input: number; output: number };

// id -> [the gateways' redirect target, the rate GET /v1/models listed for the
// id on 2026-11-24, before any gateway shipped the redirect (null: unlisted)].
const REDIRECTED: Record<string, [string, Rate | null]> = {
  "openai/o1": ["openai/gpt-5.4-mini", { input: 15, output: 60 }],
  "openai/o1-mini": ["openai/gpt-5.4-mini", null],
  "openai/o3-mini": ["openai/gpt-5.4-mini", { input: 1.1, output: 4.4 }],
  "openai/o4-mini": ["openai/gpt-5.4-mini", { input: 1.1, output: 4.4 }],
  "google/gemini-3.5-flash": ["google/gemini-3.6-flash", { input: 1.5, output: 9 }],
};

const bare = (id: string) => id.slice(id.indexOf("/") + 1);

function rateFor(model: string): Rate {
  const id = canonicalChatModel(model);
  return Object.hasOwn(CHAT_PRICE_PER_MTOKEN, id) ? CHAT_PRICE_PER_MTOKEN[id] : DEFAULT_CHAT_PRICE;
}

test("no routing tier names a retired, redirected model", () => {
  for (const [mode, ids] of Object.entries(MODEL_TIERS)) {
    for (const id of ids as readonly string[]) {
      for (const retired of Object.keys(REDIRECTED)) {
        assert.notEqual(id, retired, `${mode} routes to ${retired}, which the gateways redirect to ${REDIRECTED[retired][0]}`);
        assert.notEqual(id, bare(retired), `${mode} routes to bare ${bare(retired)}`);
      }
    }
  }
});

test("fast[0] names the model Google serves, in the position its old name held", () => {
  assert.equal(MODEL_TIERS.fast[0], "google/gemini-3.6-flash");
  assert.deepEqual(CHAT_PRICE_PER_MTOKEN["google/gemini-3.6-flash"], { input: 0.75, output: 3.75 });
});

test("every redirect target has its own price row (a tier or a pin lands on it)", () => {
  for (const [retired, [target]] of Object.entries(REDIRECTED)) {
    assert.ok(Object.hasOwn(CHAT_PRICE_PER_MTOKEN, target), `${retired} -> ${target} has no row`);
  }
});

test("a pinned retired id reserves at least its successor's rate and its last listed rate", () => {
  for (const [retired, [target, listed]] of Object.entries(REDIRECTED)) {
    const successor = CHAT_PRICE_PER_MTOKEN[target];
    for (const spelling of [retired, bare(retired)]) {
      const rate = rateFor(spelling);
      assert.ok(
        rate.input >= successor.input && rate.output >= successor.output,
        `${spelling} reserves $${rate.input}/$${rate.output}, under the $${successor.input}/$${successor.output} its redirect to ${target} is quoted`,
      );
      if (listed) {
        assert.ok(
          rate.input >= listed.input && rate.output >= listed.output,
          `${spelling} reserves $${rate.input}/$${rate.output}, under the $${listed.input}/$${listed.output} still listed until the redirect ships`,
        );
      }
    }
  }
});

test("the reserve for a pinned retired id covers the successor's reserve at every prompt size", () => {
  for (const [retired, [target]] of Object.entries(REDIRECTED)) {
    for (const chars of [1_000, 100_000, 700_000]) {
      for (const spelling of [retired, bare(retired)]) {
        const pinned = estimateChatCost(1024, undefined, spelling, undefined, chars);
        const served = estimateChatCost(1024, undefined, target, undefined, chars);
        assert.ok(pinned >= served, `${spelling} at ${chars} chars reserves ${pinned} < ${served} for ${target}`);
      }
    }
  }
});

test("o3-mini and o4-mini carry no row: theirs would under-reserve gpt-5.4-mini's output", () => {
  // $1.1/$4.4 against gpt-5.4-mini's $0.75/$4.5. The default covers both.
  for (const id of ["openai/o3-mini", "openai/o4-mini"]) {
    assert.equal(Object.hasOwn(CHAT_PRICE_PER_MTOKEN, id), false, id);
    assert.deepEqual(rateFor(id), DEFAULT_CHAT_PRICE, id);
  }
});

test("gpt-4.1-nano carries no row: $0.1/$0.4 under-reserves Solana's redirect", () => {
  // Base -> gpt-5-nano ($0.05/$0.4) until 2027-02-09; Solana -> gpt-4.1-mini
  // ($0.4/$1.6) since 2026-11-03; arc serves it at $0.1/$0.4. The default
  // covers every rail.
  assert.equal(Object.hasOwn(CHAT_PRICE_PER_MTOKEN, "openai/gpt-4.1-nano"), false);
  for (const target of ["openai/gpt-5-nano", "openai/gpt-4.1-mini"]) {
    const t = rateFor(target);
    const r = rateFor("openai/gpt-4.1-nano");
    assert.ok(r.input >= t.input && r.output >= t.output, `gpt-4.1-nano under-reserves ${target}`);
    for (const chars of [1_000, 100_000, 700_000]) {
      const pinned = estimateChatCost(1024, undefined, "openai/gpt-4.1-nano", undefined, chars);
      const served = estimateChatCost(1024, undefined, target, undefined, chars);
      assert.ok(pinned >= served, `gpt-4.1-nano at ${chars} chars reserves ${pinned} < ${served} for ${target}`);
    }
  }
});
