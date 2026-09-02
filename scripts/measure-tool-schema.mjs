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
import { writeFileSync } from "node:fs";
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

/* ── the context-cost card ──────────────────────────────────────────────────
 *
 * Generated, never hand-drawn: the figures come from the measurement above, so
 * the card cannot say something the server stopped doing. `--svg` rewrites
 * both variants; test/schema-tokens.test.ts fails if they drift.
 *
 * Two files because GitHub picks between them with <picture media=...>; an SVG
 * cannot restyle itself from the host page's colour scheme. Text is left at a
 * system font stack rather than converted to paths so it stays selectable and
 * legible at any zoom — the tradeoff is that positions are hand-tuned with
 * enough slack that a wider glyph set cannot collide.
 */
const REFERENCE_WINDOW = 200_000;

export function renderCard({ total, tradingTotal, cut, dark }) {
  const c = dark
    ? { bg: "#0B0A0F", stroke: "#26242E", label: "#8A8797", value: "#FFFFFF", accent: "#5B9BF6", muted: "#6E6B7B" }
    : { bg: "#FFFFFF", stroke: "#E4E2E8", label: "#6E6B7B", value: "#0B0A0F", accent: "#2563EB", muted: "#8A8797" };
  const pct = Math.round((total / REFERENCE_WINDOW) * 100);
  const sans = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
  const mono = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="620" height="150" viewBox="0 0 620 150" role="img" aria-label="Context cost: ${asK(total)} tokens, ${pct}% of a 200K context window; ${asK(tradingTotal)} with --profile trading, ${cut}% less">
  <defs><clipPath id="card-${dark ? "d" : "l"}"><rect x="0.5" y="0.5" width="619" height="149" rx="12"/></clipPath></defs>
  <rect x="0.5" y="0.5" width="619" height="149" rx="12" fill="${c.bg}" stroke="${c.stroke}"/>
  <rect x="0.5" y="0.5" width="5" height="149" fill="${c.accent}" clip-path="url(#card-${dark ? "d" : "l"})"/>
  <text x="28" y="34" font-family="${sans}" font-size="11" font-weight="600" letter-spacing="1.6" fill="${c.label}">CONTEXT COST</text>
  <text x="28" y="78" font-family="${sans}" font-size="34" font-weight="700" fill="${c.value}">${asK(total)} tokens</text>
  <text x="28" y="103" font-family="${sans}" font-size="13" fill="${c.muted}">${pct}% of a 200K context window · every turn, whether or not you call a tool</text>
  <text x="28" y="127" font-family="${sans}" font-size="13" fill="${c.label}">${asK(tradingTotal)} with <tspan font-family="${mono}" fill="${c.accent}">--profile trading</tspan> — ${cut}% less</text>
  <text x="592" y="34" text-anchor="end" font-family="${mono}" font-size="10.5" fill="${c.muted}">measured, not estimated</text>
</svg>
`;
}

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

if (flags.has("--svg")) {
  const full = results.full, trading = results.trading;
  if (!full || !trading) throw new Error("--svg needs the full and trading profiles (drop `-- <cmd>`)");
  const cut = Math.round((1 - trading.total / full.total) * 100);
  for (const dark of [false, true]) {
    const file = new URL(`../assets/context-cost${dark ? "-dark" : ""}.svg`, import.meta.url);
    writeFileSync(file, renderCard({ total: full.total, tradingTotal: trading.total, cut, dark }));
    console.log(`wrote ${fileURLToPath(file).split("/").slice(-2).join("/")}`);
  }
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
