// src/tools/exa.ts
//
// Exa neural web search — path-based passthrough. Full action catalog
// (search / answer / contents / find-similar) lives in the exa-research skill,
// not the tool description.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getClient } from "../utils/wallet.js";
import { formatError, extractErrorMessage } from "../utils/errors.js";

type RawClient = {
  getWithPaymentRaw: (endpoint: string, params?: Record<string, string>) => Promise<unknown>;
  requestWithPaymentRaw: (endpoint: string, body: unknown) => Promise<unknown>;
};

export function registerExaTool(server: McpServer): void {
  server.registerTool(
    "blockrun_exa",
    {
      description: `Neural web search via Exa — understands meaning, not just keywords. Great for research.

Common paths (all POST, body shapes documented in the exa-research skill):
- search       — body: { query, numResults?, category?, includeDomains?, excludeDomains? }   ($0.01/call)
- answer       — body: { query }                                                              ($0.01/call)
- contents     — body: { urls: [...] }                                                        ($0.002/URL, up to 100)
- find-similar — body: { url, numResults? }                                                   ($0.01/call)

Categories for search: "news", "research paper", "company", "tweet", "github", "pdf".

Full request/response shapes + worked research workflows in the \`exa-research\` skill.`,
      inputSchema: {
        path: z.string().describe("Endpoint name under /v1/exa/, e.g. 'search', 'answer', 'contents', 'find-similar'"),
        body: z.any().optional().describe("JSON body for the call. Sent as POST. Required for all four endpoints."),
      },
    },
    async ({ path, body }) => {
      try {
        const client = getClient() as unknown as RawClient;
        const cleanPath = path.replace(/^\/+/, "").replace(/^v1\/exa\//, "");
        const endpoint = `/v1/exa/${cleanPath}`;
        const result = await client.requestWithPaymentRaw(endpoint, body ?? {});
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result as Record<string, unknown>,
        };
      } catch (err) {
        return { content: [{ type: "text", text: formatError(extractErrorMessage(err)) }], isError: true };
      }
    }
  );
}
