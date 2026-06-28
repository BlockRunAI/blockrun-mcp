// Run with: npm test  (tsx --test)
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { fetchWithTimeout } from "../src/utils/http.js";

// The timeout must cover BODY consumption, not just time-to-headers. Clearing
// the abort timer the moment fetch() resolves (headers arrived) left a stalled
// body read with no abort coverage.
test("fetchWithTimeout's timeout covers a response body that stalls after headers", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.write("partial"); // headers + partial body, then never end()
  });
  await new Promise<void>((r) => server.listen(0, r));
  const { port } = server.address() as { port: number };
  try {
    const resp = await fetchWithTimeout(`http://127.0.0.1:${port}/`, {}, 300);
    const read = resp.text().then(() => "READ").catch(() => "ABORTED");
    const guard = new Promise<string>((r) => setTimeout(() => r("HUNG"), 2000));
    assert.equal(await Promise.race([read, guard]), "ABORTED");
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});
