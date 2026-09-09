// Run with: npm test  (tsx --test)
//
// Pay what you were told, or nothing. The gateway's 402 is authoritative for the
// price, but the tool told the model a published rate first; when the two are
// far apart the right move is to refuse unsigned, not to re-reserve and pay.
// Found live 2026-09-08: sol.blockrun.ai quotes azure/sora-2 as "Seedance 2.0
// Pro video generation (5s)" at $1.135480 where Base quotes $0.421001.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  QUOTE_TOLERANCE_FLOOR_USD,
  QUOTE_TOLERANCE_RATIO,
  QuoteMismatchError,
  assertQuoteNearEstimate,
} from "../src/utils/budget.js";
import { assertVideoQuoteSane } from "../src/tools/video.js";

test("a quote at or a little above the estimate passes (token-priced renders land within a cent)", () => {
  assert.doesNotThrow(() => assertQuoteNearEstimate(0.421001, 0.422001, { what: "x" }));
  assert.doesNotThrow(() => assertQuoteNearEstimate(1.13548, 1.13748, { what: "x" }));
  assert.doesNotThrow(() => assertQuoteNearEstimate(0.62, 0.42, { what: "x" })); // 1.48x
});

test("the floor keeps a tiny quote from reading as a multiple", () => {
  // 3x, but only $0.002 apart — well under the floor.
  assert.doesNotThrow(() => assertQuoteNearEstimate(0.003, 0.001, { what: "x" }));
  assert.ok(QUOTE_TOLERANCE_FLOOR_USD > 0.002);
});

test("null / free estimates are not judged here", () => {
  assert.doesNotThrow(() => assertQuoteNearEstimate(null, 0.42, { what: "x" }));
  assert.doesNotThrow(() => assertQuoteNearEstimate(undefined, 0.42, { what: "x" }));
  assert.doesNotThrow(() => assertQuoteNearEstimate(5, 0, { what: "x" }));
});

test("the live Sora-on-Solana quote is refused, named, and says no charge was made", () => {
  assert.throws(
    () => assertQuoteNearEstimate(1.13548, 0.422001, { what: "azure/sora-2 video", quotedFor: "Seedance 2.0 Pro video generation (5s)", hint: "Switch to Base." }),
    (err: unknown) => {
      assert.ok(err instanceof QuoteMismatchError);
      assert.equal(err.quotedUsd, 1.13548);
      assert.match(err.message, /quoted \$1\.1355 for azure\/sora-2 video/);
      assert.match(err.message, /expected about \$0\.4220/);
      assert.match(err.message, /2\.7x/);
      assert.match(err.message, /"Seedance 2\.0 Pro video generation \(5s\)"/);
      assert.match(err.message, /no charge was made/);
      assert.match(err.message, /Switch to Base\./);
      return true;
    },
  );
  assert.equal(QUOTE_TOLERANCE_RATIO, 1.5);
});

test("the video wrapper adds the Sora/Solana explanation only where it applies", () => {
  assert.throws(() => assertVideoQuoteSane(1.13548, 0.422001, "azure/sora-2", "solana", "Seedance 2.0 Pro video generation (5s)"),
    /does not serve azure\/sora-2 yet.*chain:"base"/);
  assert.throws(() => assertVideoQuoteSane(3, 1, "bytedance/seedance-2.0", "solana"), /Retry on Base/);
  assert.throws(() => assertVideoQuoteSane(3, 1, "bytedance/seedance-2.0", "base"), /Retry on Solana/);
  assert.doesNotThrow(() => assertVideoQuoteSane(0.421001, 0.422001, "azure/sora-2", "base"));
});

// --- blockrun_image's quote guard, which nothing exercised (round 2) ---
//
// The guard was added to image.ts in 0.49.0 and deleting it left every test
// green. These pin the two things the Solana onQuote hook must do — refuse a
// quote far above the published rate, and let a real one through — using the
// same figures the gateway quotes.
test("the image quote guard refuses a substituted product and passes a real one", async () => {
  const { assertQuoteNearEstimate, QuoteMismatchError } = await import("../src/utils/budget.js");
  // nano-banana at 1024: $0.01675 estimate. A 2.7x substitution is refused.
  assert.throws(
    () => assertQuoteNearEstimate(0.0452, 0.01675, { what: "google/nano-banana image", quotedFor: "Seedance 2.0 Pro video generation (5s)" }),
    (err: unknown) => {
      assert.ok(err instanceof QuoteMismatchError);
      assert.match((err as Error).message, /google\/nano-banana image/);
      assert.match((err as Error).message, /no charge was made/);
      return true;
    },
  );
  // A real size-tier difference stays inside the tolerance.
  assert.doesNotThrow(() => assertQuoteNearEstimate(0.0177, 0.01675, { what: "google/nano-banana image" }));
  // And the floor keeps a cheap image from reading as a multiple.
  assert.doesNotThrow(() => assertQuoteNearEstimate(0.03, 0.01675, { what: "x" }));
});

test("image.ts actually calls the guard on the rail that has a quote", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/tools/image.ts", import.meta.url), "utf8");
  // The Solana helper is the only image rail that surfaces a 402 amount.
  assert.match(src, /solanaPaidPost\([\s\S]{0,400}onQuote:/, "image must guard the Solana quote");
  assert.match(src, /assertQuoteNearEstimate\(/, "image must call the shared guard");
});
