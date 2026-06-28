// Run with: npm test  (tsx --test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { looksLikeRawPrivateKey, looksLikeNamedSecretValue } from "../src/utils/key-leak-scanner.js";

test("a bare (no-0x) 64-hex key is detected under a key-named field", () => {
  const bare = "a".repeat(64); // MetaMask "Export Private Key" format
  assert.equal(looksLikeNamedSecretValue(bare), true);
  assert.equal(looksLikeNamedSecretValue("0x" + "a".repeat(64)), true);
});

test("strict matcher still catches 0x-prefixed EVM and bs58 Solana keys", () => {
  assert.equal(looksLikeRawPrivateKey("0x" + "a".repeat(64)), true);
  assert.equal(looksLikeRawPrivateKey("5".repeat(88)), true); // bs58-shaped Solana key
});

test("strict matcher does NOT flag a bare 64-hex value (avoids SHA-256 false positives)", () => {
  // Used by the untagged catch-all branch, so an unrelated 64-hex hash must pass.
  assert.equal(looksLikeRawPrivateKey("a".repeat(64)), false);
});

test("neither matcher flags ordinary short strings", () => {
  assert.equal(looksLikeRawPrivateKey("hello"), false);
  assert.equal(looksLikeNamedSecretValue("hello"), false);
  assert.equal(looksLikeNamedSecretValue(42 as unknown as string), false);
});
