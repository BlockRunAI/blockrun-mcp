#!/usr/bin/env node
/**
 * Measure what an MCP server costs a model's context window.
 *
 * Installing an MCP server puts every tool's schema into the model's prompt,
 * on every turn, whether or not the tools are ever called. Package managers
 * have shown install size for decades; nothing shows this. So: measure it.
 *
 *   node scripts/measure-tool-schema.mjs                     this repo, every profile
 *   node scripts/measure-tool-schema.mjs --json              machine-readable
 *   node scripts/measure-tool-schema.mjs -- npx -y @foo/bar  ANY stdio MCP server
 *
 * Requires `gpt-tokenizer` (a devDependency here; `npm i gpt-tokenizer` elsewhere).
 *
 * WHAT IS COUNTED: the model-visible projection — `{name, description,
 * input_schema}` per tool, with the host's name prefix — because that is what
 * lands in the API `tools` array. Not counted: `annotations`, `_meta` and
 * `outputSchema`, which the host consumes and does not forward to the model.
 * On this server that wire overhead is a further ~3.7%.
 *
 * TWO WAYS TO GET THIS WRONG, both of which cost us a retraction:
 *
 *   1. Reading your own source instead of the wire. The schema the model
 *      receives is GENERATED — the SDK adds fields your source never mentions.
 *      Always measure a live `tools/list`.
 *   2. Re-encoding before counting. `JSON.stringify` is correct because it
 *      leaves non-ASCII alone. Python's `json.dumps` defaults to
 *      `ensure_ascii=True`, which turns every em-dash into `\uXXXX` — six
 *      characters where the model sees one glyph. That inflated our first
 *      numbers by 4.4%. If your count disagrees with a colleague's while your
 *      DESCRIPTION totals match to the token, this is why.
 *
 * The tokenizer is o200k_base. Claude's tokenizer is not public and runs a few
 * percent higher on JSON, so every number here is a slight UNDER-count.
 */
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { encode } from "gpt-tokenizer/encoding/o200k_base";

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
const userCmd = sep === -1 ? [] : argv.slice(sep + 1);
const flags = new Set(sep === -1 ? argv : argv.slice(0, sep));
const asJson = flags.has("--json");

const SERVER = fileURLToPath(new URL("../dist/index.js", import.meta.url));
// Only this repo's own server has profiles to sweep; a foreign server is one run.
const PROFILES = userCmd.length ? [null] : ["full", "media", "trading", "research", "chat"];
const PREFIX = process.env.MCP_PREFIX ?? (userCmd.length ? "" : "mcp__blockrun__");

/** One MCP handshake over stdio. Returns the tools array verbatim. */
function listTools(cmd) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd[0], cmd.slice(1), { stdio: ["pipe", "pipe", "ignore"] });
    const pending = new Map();
    let buf = "";
    let id = 0;

    const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
    const rpc = (method, params) =>
      new Promise((res) => {
        pending.set(++id, res);
        send({ jsonrpc: "2.0", id, method, params });
      });

    child.on("error", reject);
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timed out waiting for ${cmd.join(" ")}`));
    }, 60_000);

    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        const done = pending.get(msg.id);
        if (done) { pending.delete(msg.id); done(msg); }
      }
    });

    (async () => {
      await rpc("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "measure-tool-schema", version: "1.0.0" },
      });
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      const { result } = await rpc("tools/list", {});
      clearTimeout(timer);
      child.kill();
      resolve(result?.tools ?? []);
    })().catch(reject);
  });
}

/** The projection the model actually receives, tokenized. */
export function measure(tools, prefix = "") {
  const rows = tools.map((t) => {
    const schema = t.inputSchema ?? {};
    const description = t.description ?? "";
    return {
      tool: t.name,
      tokens: encode(JSON.stringify({
        name: prefix + t.name,
        description,
        input_schema: schema,
      })).length,
      description: encode(description).length,
      schema: encode(JSON.stringify(schema)).length,
    };
  });
  rows.sort((a, b) => b.tokens - a.tokens);
  const total = rows.reduce((n, r) => n + r.tokens, 0);
  return {
    tools: rows.length,
    total,
    descriptions: rows.reduce((n, r) => n + r.description, 0),
    schemas: rows.reduce((n, r) => n + r.schema, 0),
    perTool: rows.length ? Math.round(total / rows.length) : 0,
    rows,
  };
}

/** 12900 -> "12.9K". The form the README badge publishes. */
export const asK = (n) => `${(Math.round(n / 100) / 10).toFixed(1)}K`;

// Importable: test/schema-tokens.test.ts reuses measure()/asK() to pin the
// published number, so the CLI half must not run on import.
const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (!isCli) { /* library use */ } else await main();

async function main() {
const results = {};
for (const profile of PROFILES) {
  const cmd = userCmd.length
    ? userCmd
    : ["node", SERVER, ...(profile && profile !== "full" ? ["--profile", profile] : [])];
  results[profile ?? userCmd.join(" ")] = measure(await listTools(cmd), PREFIX);
}

if (asJson) {
  console.log(JSON.stringify(results, null, 2));
} else {
  const [headline] = Object.values(results);
  for (const [name, r] of Object.entries(results)) {
    const pct = (n) => `${((n / r.total) * 100).toFixed(1)}%`;
    console.log(
      `\n${name} — ${r.total.toLocaleString()} tokens across ${r.tools} tools ` +
      `(${r.perTool}/tool · descriptions ${pct(r.descriptions)} · schemas ${pct(r.schemas)})`,
    );
    if (name === "full" || PROFILES.length === 1) console.table(r.rows);
  }
  console.log(`\nbadge: ${asK(headline.total)}`);
}
}
