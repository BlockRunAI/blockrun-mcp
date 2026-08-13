// Run with: npm test  (tsx --test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateModalCost } from "../src/tools/modal.js";

// sandbox/create is priced off the BODY (gpu + timeout), not the path. The old
// estimator branched on the path alone and reserved a flat $0.01 for every
// create — so a $1 agent cap could settle $192 of NON-REFUNDABLE spend:
//
//   { timeout: 86400, gpu: "H100" } charged $192.0020 against a $0.012 reserve.
//
// Every figure below is the gateway's own quote, read from the live
// payment-required header (free to request — no payment attached). It mirrors
// getModalCreatePricing() in the gateway's src/lib/modal.ts:
//   timeout <= 300s -> flat (CPU $0.01, GPU per tier)
//   timeout >  300s -> hourly x (timeout/3600), EXACT, charged upfront, no refund
const CHARGED: Array<[string, unknown, number]> = [
  // path-only operations
  ["sandbox/exec", { sandbox_id: "sb", command: ["echo"] }, 0.003],
  ["sandbox/status", undefined, 0.003],
  ["sandbox/terminate", { sandbox_id: "sb" }, 0.003],
  // flat tier: timeout <= 300
  ["sandbox/create", {}, 0.012],
  ["sandbox/create", { timeout: 300 }, 0.012],
  ["sandbox/create", { timeout: 300, gpu: "T4" }, 0.052001],
  ["sandbox/create", { timeout: 300, gpu: "H100" }, 0.402001],
  // hourly tier: timeout > 300, exact hours (not rounded up)
  ["sandbox/create", { timeout: 3600, gpu: "A100" }, 4.002001],
  ["sandbox/create", { timeout: 86400, gpu: "H100" }, 192.002],
  ["sandbox/create", { timeout: 3600 }, 0.102001], // CPU hourly $0.10
  ["sandbox/create", { timeout: 1801, gpu: "T4" }, 1.5 * (1801 / 3600) + 0.002],
];

test("estimateModalCost reserves what the gateway actually charges", () => {
  for (const [path, body, charged] of CHARGED) {
    const got = estimateModalCost(path, body);
    assert.ok(
      got >= charged - 1e-6,
      `${path} ${JSON.stringify(body)}: reserved $${got} < charged $${charged} — the gate would under-reserve`,
    );
    assert.ok(
      got - charged < 0.01,
      `${path} ${JSON.stringify(body)}: reserved $${got} vs charged $${charged} — over-reserving blocks affordable calls`,
    );
  }
});

test("estimateModalCost never reserves the flat rate for an expensive sandbox", () => {
  // The exact bug: path-only estimation. A 24h H100 must not price like a create.
  const cheap = estimateModalCost("sandbox/create", { timeout: 300 });
  const expensive = estimateModalCost("sandbox/create", { timeout: 86400, gpu: "H100" });
  assert.ok(expensive > cheap * 1000, `24h H100 ($${expensive}) must dwarf a flat create ($${cheap})`);
});

test("estimateModalCost falls back to the CPU rate for an unknown gpu, like the gateway", () => {
  assert.equal(estimateModalCost("sandbox/create", { timeout: 300, gpu: "NOPE" }), 0.012);
  assert.equal(estimateModalCost("sandbox/create", { timeout: 3600, gpu: "NOPE" }), 0.102001);
});

// A plain object literal inherits from Object.prototype, so TABLE["toString"]
// returns a FUNCTION and `?? default` never fires. That function flowed into the
// budget gate as NaN and permanently disabled every cap for the process:
// reserveBudget does Math.max(0, fn) = NaN, checkBudget's `cost > 0` is false so
// it ALLOWS, and `spent += NaN` sticks — a $1-capped agent was then cleared for a
// $500 call. The "unknown gpu" test above is blind to it: ordinary keys like
// "NOPE" fall back correctly; only prototype keys escape. Hence a Map.
test("estimateModalCost is not fooled by Object.prototype keys as a gpu", () => {
  for (const key of ["toString", "valueOf", "constructor", "hasOwnProperty", "__proto__", "isPrototypeOf"]) {
    for (const timeout of [300, 3600]) {
      const got = estimateModalCost("sandbox/create", { timeout, gpu: key });
      assert.equal(typeof got, "number", `gpu:"${key}" timeout:${timeout} returned a ${typeof got}, not a number`);
      assert.ok(Number.isFinite(got), `gpu:"${key}" timeout:${timeout} returned ${got}`);
      // must fall back to the CPU rate, exactly like any other unknown gpu
      assert.equal(got, timeout > 300 ? 0.102001 : 0.012, `gpu:"${key}" must fall back to the CPU rate`);
    }
  }
});

test("estimateModalCost treats a missing/garbage timeout as the 300s default (flat)", () => {
  for (const t of [undefined, null, "3600", 0, -5, NaN, {}]) {
    assert.equal(
      estimateModalCost("sandbox/create", { timeout: t }),
      0.012,
      `timeout=${JSON.stringify(t)} should fall back to the flat default`,
    );
  }
});

// The classifier must price the route the URL parser will SEND, not the string
// the caller typed. `path.includes("sandbox/create")` compared the raw slug, so
// one invisible character moved a $192.00 non-refundable create into the $0.003
// operation tier — and reserveBudget then admitted it against ANY cap, since
// $0.003 clears a $1.00 global limit and a $0.05 agent delegation alike.
// Verified against the real parser: new URL(base + "sandbox/cre\tate").pathname
// === "/api/v1/modal/sandbox/create".
test("estimateModalCost prices tab/LF/CR-obfuscated sandbox/create as a create, not a $0.003 op", () => {
  const BASE = "https://blockrun.ai/api/v1/modal/";
  for (const raw of ["sandbox/cre\tate", "sandbox/cr\neate", "sandbox\r/create"]) {
    assert.equal(new URL(BASE + raw).pathname, "/api/v1/modal/sandbox/create", raw);
    assert.equal(estimateModalCost(raw, { timeout: 86400, gpu: "H100" }), 192.002, raw);
  }
});

test("estimateModalCost decodes percent-escapes, which the gateway router resolves", () => {
  // fetch() forwards %63 untouched; the gateway decodes it when routing, so
  // this reaches the same create handler.
  assert.equal(estimateModalCost("sandbox/%63reate", { timeout: 86400, gpu: "H100" }), 192.002);
  assert.equal(estimateModalCost("modal/sandbox/create/", { timeout: 86400, gpu: "H100" }), 192.002);
  assert.equal(estimateModalCost("SANDBOX/CREATE", { timeout: 86400, gpu: "H100" }), 192.002);
  // One decode only — %2563reate is not %63reate is not create.
  assert.equal(estimateModalCost("sandbox/%2563reate", { timeout: 86400, gpu: "H100" }), 0.003);
});
