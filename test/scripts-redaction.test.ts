// Run with: npm test  (tsx --experimental-test-module-mocks --test)
//
// The live Polymarket e2e scripts run against a real funded wallet, and their
// output goes into terminals, CI logs and issue comments. Three of them state
// in their own doc comment that wallet addresses and transaction ids are never
// printed. Each had implemented that promise with a DIFFERENT regex, and the
// one used by the two scripts that actually move money matched `{64}` only —
// so a 40-hex address printed in full, and withdraw.ts really does interpolate
// a bridge response carrying an address into its error text.
//
// Nothing here runs a script. The first tests exercise the shared helper; the
// last reads the scripts as text and fails if one grows its own regex again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { redactChainValues } from "../scripts/redact.js";

const SCRIPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts");

const WALLET = "0x" + "ab".repeat(20);
const TX = "0x" + "cd".repeat(32);

test("a wallet address is redacted, not just a transaction hash", () => {
  const out = redactChainValues(`Bridge did not return an address (got: ${WALLET}).`);
  assert.equal(out.includes(WALLET), false, "the address must not survive");
  assert.match(out, /<wallet>/);
});

test("a transaction hash is labelled as one and never half-eaten by the address rule", () => {
  const out = redactChainValues(`submitted ${TX}`);
  assert.equal(out, "submitted <tx>");
  assert.equal(out.includes("cd"), false, "no tail of the hash may leak past a 40-char match");
});

test("both in one string, in either order", () => {
  assert.equal(
    redactChainValues(`from ${WALLET} tx ${TX} back to ${WALLET}`),
    "from <wallet> tx <tx> back to <wallet>",
  );
  assert.equal(redactChainValues(`${TX} ${WALLET}`), "<tx> <wallet>");
});

test("a 32-byte private key comes out redacted (mislabelled is fine, printed is not)", () => {
  const key = "0x" + "11".repeat(32);
  assert.equal(redactChainValues(`key=${key}`).includes("11"), false);
});

test("anything else long and hex is redacted rather than passed through", () => {
  const odd = "0x" + "ef".repeat(25);
  const out = redactChainValues(`blob ${odd}`);
  assert.equal(out.includes(odd), false);
  assert.match(out, /<redacted>/);
});

test("short hex is left alone — a token id or a selector is not a secret", () => {
  assert.equal(redactChainValues("selector 0xdeadbeef"), "selector 0xdeadbeef");
});

test("no e2e script carries its own address/hash regex", () => {
  const offenders: string[] = [];
  for (const name of readdirSync(SCRIPTS)) {
    if (!name.startsWith("polymarket-e2e-")) continue;
    const source = readFileSync(path.join(SCRIPTS, name), "utf-8");
    if (/0x\[a-fA-F0-9\]\{/.test(source)) offenders.push(name);
  }
  assert.deepEqual(
    offenders,
    [],
    "redact via scripts/redact.ts — four hand-rolled regexes is how the {64}-only " +
      "one shipped in the two scripts that move real money",
  );
});
