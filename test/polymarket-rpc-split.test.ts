// Run with: npm test  (tsx --test)
//
// Reads and writes used ONE list, whose entry 0 doubled as the sole
// un-fallbacked transport for every signing wallet client. So reordering what
// read like a read-only fallback list silently changed which endpoint
// broadcasts every money transaction — a write-path change disguised as a
// comment tweak. These pin the separation so it cannot quietly collapse back.
import test from "node:test";
import assert from "node:assert/strict";
import { POLYGON_READ_RPC_URLS, POLYGON_WRITE_RPC_URL } from "../src/utils/polymarket/constants.js";
import { readFileSync, readdirSync } from "node:fs";

test("the read list is a real fallback chain", () => {
  assert.ok(POLYGON_READ_RPC_URLS.length >= 2, "one entry is not a fallback");
  assert.equal(new Set(POLYGON_READ_RPC_URLS).size, POLYGON_READ_RPC_URLS.length, "duplicates give false depth");
  for (const u of POLYGON_READ_RPC_URLS) assert.match(u, /^https:\/\//);
});

test("the write endpoint is a single https URL, not a list", () => {
  assert.equal(typeof POLYGON_WRITE_RPC_URL, "string");
  assert.match(POLYGON_WRITE_RPC_URL, /^https:\/\//);
});

// 1rpc answers once then returns -32001 "usage limit" (measured 2026-07-21).
// Broadcasting a withdrawal through a throttled endpoint is the failure mode
// this split exists to avoid, so it must not be the default.
test("the write endpoint does not default to the rate-limited provider", () => {
  if (process.env.POLYMARKET_WRITE_RPC_URL) return; // operator override wins
  assert.doesNotMatch(POLYGON_WRITE_RPC_URL, /1rpc\.io/);
});

// The whole point: no signing client may reach for the read list.
test("no signing client is built from the READ fallback list", () => {
  const dir = "src/utils/polymarket";
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
  let checked = 0;
  for (const f of files) {
    const src = readFileSync(`${dir}/${f}`, "utf8");
    for (const line of src.split("\n")) {
      // Only SIGNING clients matter here; the read fallback legitimately maps
      // POLYGON_READ_RPC_URLS through http().
      if (!line.includes("createWalletClient")) continue;
      checked++;
      assert.doesNotMatch(line, /POLYGON_READ_RPC_URLS/, `${f}: a signing client must use POLYGON_WRITE_RPC_URL`);
    }
  }
  assert.ok(checked > 0, "found no createWalletClient call — the guard would be vacuous");
});
