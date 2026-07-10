// Run with: npm test  (tsx --test)
//
// The underscore-header survival fix (client.ts installUnderscoreHeaderBridge):
// Polymarket's auth headers contain underscores, which proxies (Caddy/Cloud Run)
// strip — so when routing through a relay the MCP also sends each as a hyphenated
// copy. This verifies the interceptor adds those copies for both AxiosHeaders and
// plain-object header shapes, without hitting the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import axios, { AxiosHeaders } from "axios";
import { installUnderscoreHeaderBridge } from "../src/utils/polymarket/client.js";

// Pull the interceptor's fulfilled fn out of a fresh instance so we can run it
// against a config directly (no request goes out).
function bridgeFn() {
  const inst = axios.create();
  installUnderscoreHeaderBridge(inst as never);
  const handlers = (inst.interceptors.request as unknown as { handlers: { fulfilled: (c: unknown) => unknown }[] }).handlers;
  return handlers[handlers.length - 1].fulfilled;
}

test("adds hyphenated copies of every underscore auth header (AxiosHeaders)", () => {
  const fn = bridgeFn();
  const headers = AxiosHeaders.from({
    POLY_ADDRESS: "0xABC",
    POLY_SIGNATURE: "0xsig",
    POLY_TIMESTAMP: "1700000000",
    POLY_NONCE: "0",
    POLY_API_KEY: "key-1",
    POLY_PASSPHRASE: "pass-1",
    POLY_BUILDER_API_KEY: "bkey",
    POLY_BUILDER_SIGNATURE: "0xbsig",
    "content-type": "application/json",
  });
  fn({ headers });

  assert.equal(headers.get("poly-address"), "0xABC");
  assert.equal(headers.get("poly-signature"), "0xsig");
  assert.equal(headers.get("poly-timestamp"), "1700000000");
  assert.equal(headers.get("poly-nonce"), "0");
  assert.equal(headers.get("poly-api-key"), "key-1");
  assert.equal(headers.get("poly-passphrase"), "pass-1");
  assert.equal(headers.get("poly-builder-api-key"), "bkey");
  assert.equal(headers.get("poly-builder-signature"), "0xbsig");
  // Originals are preserved (sent alongside; the relay maps hyphen → underscore).
  assert.equal(headers.get("POLY_ADDRESS"), "0xABC");
});

test("no-op when no auth headers are present", () => {
  const fn = bridgeFn();
  const headers = AxiosHeaders.from({ "content-type": "application/json" });
  fn({ headers });
  assert.equal(headers.has("poly-address"), false);
});

test("works with a plain-object headers shape too", () => {
  const fn = bridgeFn();
  const headers: Record<string, unknown> = { POLY_ADDRESS: "0xDEF", POLY_SIGNATURE: "0xs2" };
  fn({ headers });
  assert.equal(headers["poly-address"], "0xDEF");
  assert.equal(headers["poly-signature"], "0xs2");
});

test("tolerates a missing headers object", () => {
  const fn = bridgeFn();
  assert.doesNotThrow(() => fn({}));
});
