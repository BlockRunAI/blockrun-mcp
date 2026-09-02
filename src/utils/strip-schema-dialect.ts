// src/utils/strip-schema-dialect.ts
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Drop the `"$schema": "http://json-schema.org/draft-07/schema#"` header the
 * SDK's zod→JSON-Schema conversion stamps onto every tool's inputSchema.
 *
 * It is a dialect declaration: MCP clients validate the schema either way, and
 * the Anthropic API ignores it outright. But it is emitted once per tool and
 * lands in the model's context on every turn — 14 tokens x 20 tools = 280
 * tokens of pure boilerplate in a 13.8K-token tool block.
 *
 * The SDK gives no option to suppress it, so we intercept the `tools/list`
 * handler as it is installed. This uses only the public `setRequestHandler`,
 * and if a future SDK stops routing through `ListToolsRequestSchema` the
 * wrapper simply stops matching — the `$schema` key comes back and nothing
 * breaks. Must run BEFORE the first tool is registered, since that is when the
 * SDK lazily installs the handler.
 */
export function stripJsonSchemaDialect(server: McpServer): void {
  // Purely an optimization: if the low-level server isn't there to wrap (a
  // test double, a future SDK shape), skip it rather than throw. The worst
  // case is that `$schema` stays in the payload.
  const lowLevel = server.server;
  if (typeof lowLevel?.setRequestHandler !== "function") return;
  const original = lowLevel.setRequestHandler.bind(lowLevel);

  lowLevel.setRequestHandler = ((requestSchema: unknown, handler: (...args: unknown[]) => unknown) => {
    if (requestSchema !== ListToolsRequestSchema) {
      return original(requestSchema as never, handler as never);
    }
    return original(requestSchema as never, (async (...args: unknown[]) => {
      const result = await handler(...args) as { tools?: { inputSchema?: Record<string, unknown> }[] };
      // The SDK rebuilds these objects on every call, so mutating is safe.
      for (const tool of result?.tools ?? []) {
        if (tool.inputSchema) delete tool.inputSchema.$schema;
      }
      return result;
    }) as never);
  }) as typeof lowLevel.setRequestHandler;
}
