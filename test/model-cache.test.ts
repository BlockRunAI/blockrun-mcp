// Run with: npm test  (tsx --test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadModels, type ModelCache } from "../src/utils/model-cache.js";

test("loadModels does not pin an empty catalogue for the TTL (re-fetches until non-empty)", async () => {
  let calls = 0;
  const cache: ModelCache = { models: null };
  const lister = {
    listModels: async () => {
      calls++;
      return (calls < 2 ? [] : [{ id: "m1" }]) as any;
    },
  };
  const first = await loadModels(lister, cache);
  assert.equal(first.length, 0, "empty upstream result is returned");
  const second = await loadModels(lister, cache);
  assert.equal(second.length, 1, "empty result was NOT cached, so it re-fetched");
  assert.equal(calls, 2);
});

test("loadModels caches a non-empty catalogue (no re-fetch within TTL)", async () => {
  let calls = 0;
  const cache: ModelCache = { models: null };
  const lister = { listModels: async () => { calls++; return [{ id: "a" }, { id: "b" }] as any; } };
  await loadModels(lister, cache);
  await loadModels(lister, cache);
  assert.equal(calls, 1, "non-empty result is cached");
});
