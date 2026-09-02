# What this server costs your context, and how we measure it

Installing an MCP server spends the model's context on **every turn** — the client loads each
tool's schema into the prompt and re-sends it for the whole session, whether or not a tool is
ever called. This documents what BlockRun MCP costs, how the figure is produced, and one
ecosystem-wide finding that came out of measuring it.

Harness: [`scripts/measure-tool-schema.mjs`](../scripts/measure-tool-schema.mjs)
(`npm run measure:schema`). Guard: [`test/schema-tokens.test.ts`](../test/schema-tokens.test.ts),
which fails the build when the README card disagrees with a live measurement.

Written 2026-09-01, verified against `@modelcontextprotocol/sdk` 1.29.0.

## Our number

| Profile | Tools | Context |
|---------|-------|---------|
| `full` *(default)* | 20 | 12,900 |
| `trading` | 9 | 5,554 |
| `media` | 7 | 5,436 |
| `research` | 6 | 3,024 |
| `chat` | 3 | 1,924 |

Descriptions are ~54% of it, input schemas ~41%. `--profile trading` costs 57% less than the
default for the same workflow.

Measure it yourself, against us or anyone else:

```bash
npm i gpt-tokenizer
npm run measure:schema                                   # this server, every profile
node scripts/measure-tool-schema.mjs -- npx -y @some/other-mcp-server
```

Measure a *published* package from a directory outside this repo — `npx -y @blockrun/mcp@x.y.z`
run from inside the checkout resolves to the local build instead.

## The dead `$schema` header — an ecosystem finding

If you build an MCP server with the official TypeScript SDK and define your tools with zod —
which is the documented, idiomatic way — every tool's `inputSchema` goes out to the client
carrying this:

```json
"$schema": "http://json-schema.org/draft-07/schema#"
```

It is a JSON Schema *dialect declaration*, and as far as can be verified it does nothing (see
**How dead is it, exactly** below — the answer is strong but not unlimited). It rides in the tool
block the model carries on every turn, and the server author never wrote it and cannot see it in
their source.

Cost: **~15 tokens per tool.** For us, 20 tools → 300 tokens. On a 49-tool server of the kind
Uber cited, ~735 tokens. Nobody's tool budget is blown by this, but it is 100% waste, it is
invisible from the source code, and it is in essentially every SDK-built server in the ecosystem.

## How dead is it, exactly

Stronger than inference, weaker than "every client ignores it". Verified:

- **No code path in the SDK reads `$schema`.** Grepped the whole `dist`, server and client: zero
  reads.
- **The SDK's bundled validator never receives it.** ajv (`validation/ajv-provider.js`) is invoked
  on `tool.outputSchema` and on elicitation `requestedSchema` — never on `inputSchema`. In the
  reference implementation the header is not even handed to a validator.
- **It is inert for ajv anyway.** Compiling all 20 tool schemas under the SDK's exact ajv config,
  with and without the header, against 5 input samples each: identical verdicts on **100/100**
  pairs, 0 differences.

Not verified: proprietary client behaviour. Claude Code, Cursor, VS Code and Claude Desktop were
not instrumented with and without the header, and their source is not readable. So the publishable
sentence is:

> No code path in the reference SDK reads it, its bundled validator never receives it, and
> compiling the schemas with and without it produces identical validation verdicts. We did not
> instrument closed-source clients.

One nuance that cuts *toward* removing it: ajv normally uses `$schema` to select a dialect, so such
a header is not inert by construction — a draft-2020-12 URI on a draft-07 ajv instance throws. It
is inert here because the SDK emits draft-07 and configures ajv with `validateSchema: false`. That
is "happens to be fine", not "cannot matter".

## How it was verified

Not from reading one code path. Both zod branches were executed directly:

```ts
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import * as z4 from "zod";
import * as z3 from "zod/v3";

toJsonSchemaCompat(z4.object({ a: z4.string() }), { pipeStrategy: "input" }).$schema
// → "http://json-schema.org/draft-07/schema#"
toJsonSchemaCompat(z3.object({ a: z3.string() }), { pipeStrategy: "input" }).$schema
// → "http://json-schema.org/draft-07/schema#"
```

The v4 branch goes through `z4mini.toJSONSchema(schema, { target: "draft-7" })`; the v3 branch
through the vendored `zod-to-json-schema`. **Both** emit it, so the version of zod a server
happens to be on makes no difference.

It was originally found the honest way — by capturing the actual `tools/list` payload off the
wire from a running server and tokenizing it, rather than by reading our own source. That is the
transferable lesson, and arguably the better headline: **the schema the model receives is
generated, not written. If you have only ever read your source, you have not seen what you ship.**

## Why you cannot just delete it

The SDK exposes no option to suppress it. `registerTool` converts your zod schema at
`tools/list` time, inside a handler the SDK installs itself.

The fix that works without forking, patching `node_modules`, or touching SDK internals: wrap the
`tools/list` handler as it is being installed, using only the public `setRequestHandler`. Call it
before registering any tool — that is when the SDK lazily installs the handler.

Shipped here as [`src/utils/strip-schema-dialect.ts`](../src/utils/strip-schema-dialect.ts), wired
in [`src/mcp-handler.ts`](../src/mcp-handler.ts) and guarded by
[`test/schema-dialect.test.ts`](../test/schema-dialect.test.ts). Copy freely:

```ts
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export function stripJsonSchemaDialect(server: McpServer): void {
  const lowLevel = server.server;
  if (typeof lowLevel?.setRequestHandler !== "function") return;
  const original = lowLevel.setRequestHandler.bind(lowLevel);

  lowLevel.setRequestHandler = ((requestSchema, handler) => {
    if (requestSchema !== ListToolsRequestSchema) return original(requestSchema, handler);
    return original(requestSchema, async (...args) => {
      const result = await handler(...args);
      for (const tool of result?.tools ?? []) delete tool.inputSchema?.$schema;
      return result;
    });
  }) as typeof lowLevel.setRequestHandler;
}
```

Two properties worth copying along with the code, because they are what make it safe to ship:

1. **It is never load-bearing.** The wrapper is identity-matched against
   `ListToolsRequestSchema`. If a future SDK stops routing through it, the wrapper stops matching
   and the header comes back. Degraded output, never a crash.
2. **It no-ops when there is nothing to wrap.** Test suites commonly pass a minimal fake
   `McpServer` with just `registerTool`. An earlier version assumed `server.server` exists and
   broke 8 tests. An optimization that throws is worse than no optimization.

And guard it with a test. An identity-matched wrapper can be silently undone by a dependency
bump, and a saving that reverts unobserved is worse than one never made.

## Caveats worth stating whenever the number is quoted

1. **It only affects servers that define tools with zod via `registerTool`.** A server passing
   raw JSON Schema is unaffected unless it puts the header there itself. "Every SDK-built server"
   means every one using the idiomatic path — most, not all.
2. **`$schema` is a 2% win, not the story.** For us it was 300 tokens out of 13,200. The real
   weight is tool *descriptions* — ~54% of what remains, and in our case route catalogues and
   per-model pricing tables that belong in on-demand skills. That work is not done. `$schema` is
   worth citing as the illustration of the actual lesson: you cannot audit what you have not
   measured on the wire.
3. **Tool schemas are prompt-cached.** They sit at the front of the prompt, so after the first
   turn they re-send at cache-read rates (~10% of input price). The *context-window* cost is 100%
   every turn; the *dollar* cost is roughly a tenth of the naive figure. Say so — the honest
   version is damning enough, and the inflated one gets fact-checked.
4. **`o200k_base` is a proxy.** Claude's tokenizer is not public and runs a few percent higher on
   JSON, so every figure here is a slight **under**-count, never an over-count.

## The tokenizer footgun

Count the projection with the same JSON encoding the wire uses. Python's `json.dumps` defaults to
`ensure_ascii=True`, which rewrites every em-dash, arrow and `·` as `\uXXXX` — six ASCII
characters where the model sees one glyph. That inflated the first published figures by 565 tokens
(4.4%), entirely in the tools whose descriptions use typographic punctuation, and the numbers had
to be retracted after a second implementation disagreed.

Use `json.dumps(obj, ensure_ascii=False)`, or JS `JSON.stringify`, which never escapes non-ASCII.

Diagnostic fingerprint: if two counts disagree while their *description* totals match to the
token, this is why — and the tools whose descriptions are pure ASCII will show a delta of exactly
zero.

**No figure is final until a second harness reproduces it.** The numbers in this document have
been through four independent implementations.
