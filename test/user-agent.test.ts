import assert from "node:assert/strict";
import test from "node:test";
import { withBlockrunMcpUserAgent } from "../src/utils/user-agent.js";

function recorder() {
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    return new Response("ok");
  }) as typeof fetch;
  return { calls, fetcher };
}

test("overrides SDK user-agent on BlockRun gateway requests", async () => {
  const { calls, fetcher } = recorder();
  const wrapped = withBlockrunMcpUserAgent(fetcher, "0.30.0");
  await wrapped("https://blockrun.ai/api/v1/chat/completions", {
    headers: { "User-Agent": "blockrun-ts/3.5.1", "X-Test": "kept" },
  });

  const headers = new Headers(calls[0].init?.headers);
  assert.equal(headers.get("user-agent"), "blockrun-mcp/0.30.0");
  assert.equal(headers.get("x-test"), "kept");
});

test("marks Solana gateway requests as MCP", async () => {
  const { calls, fetcher } = recorder();
  const wrapped = withBlockrunMcpUserAgent(fetcher, "0.30.0");
  await wrapped("https://sol.blockrun.ai/api/v1/chat/completions");
  assert.equal(
    new Headers(calls[0].init?.headers).get("user-agent"),
    "blockrun-mcp/0.30.0",
  );
});

test("does not alter third-party requests", async () => {
  const { calls, fetcher } = recorder();
  const wrapped = withBlockrunMcpUserAgent(fetcher, "0.30.0");
  await wrapped("https://registry.npmjs.org/@blockrun/mcp/latest", {
    headers: { "User-Agent": "original" },
  });
  assert.equal(
    new Headers(calls[0].init?.headers).get("user-agent"),
    "original",
  );
});
