// Run with: npm test  (tsx --test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { isBlockedFetchHost } from "../src/utils/ssrf.js";

test("isBlockedFetchHost blocks loopback/private/link-local/metadata", () => {
  for (const h of [
    "localhost", "foo.localhost",
    "127.0.0.1", "127.1.2.3", "0.0.0.0",
    "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.1",
    "169.254.169.254", "100.64.0.1",
    "::1", "[::1]", "fc00::1", "fd12::3", "fe80::1",
    "::ffff:127.0.0.1", "::ffff:10.0.0.1",
    "metadata.google.internal", "svc.internal",
  ]) {
    assert.equal(isBlockedFetchHost(h), true, `should block ${h}`);
  }
});

test("isBlockedFetchHost blocks IPv4-mapped IPv6 in the hex form the URL parser emits", () => {
  // new URL('http://[::ffff:127.0.0.1]/').hostname === '[::ffff:7f00:1]' — the
  // decimal ::ffff:a.b.c.d form is never what the real caller passes.
  for (const h of ["::ffff:7f00:1", "[::ffff:7f00:1]", "::ffff:a9fe:a9fe", "::ffff:a00:5"]) {
    assert.equal(isBlockedFetchHost(h), true, `should block ${h}`);
  }
  assert.equal(isBlockedFetchHost("::ffff:808:808"), false, "8.8.8.8 mapped is public");
});

test("isBlockedFetchHost blocks the hostname new URL() actually produces for mapped literals", () => {
  for (const u of [
    "http://[::ffff:127.0.0.1]/x.png",
    "http://[::ffff:169.254.169.254]/",
    "http://[::ffff:10.0.0.5]/internal.png",
  ]) {
    assert.equal(isBlockedFetchHost(new URL(u).hostname), true, u);
  }
});

test("isBlockedFetchHost allows public hosts", () => {
  for (const h of [
    "example.com", "cdn.openai.com", "blockrun.ai",
    "8.8.8.8", "1.1.1.1", "172.32.0.1", "11.0.0.1",
    "2606:4700:4700::1111",
  ]) {
    assert.equal(isBlockedFetchHost(h), false, `should allow ${h}`);
  }
});
