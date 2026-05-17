// src/tools/search.ts
//
// Grok Live Search — real-time web, X/Twitter, and news search with AI-summarized
// results and citations. Path-based passthrough (one endpoint today, future-proof
// for additional surfaces). Sources, pagination, dates documented in the search
// skill, not the tool description.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getClient } from "../utils/wallet.js";
import { formatError, extractErrorMessage } from "../utils/errors.js";

type RawClient = {
  getWithPaymentRaw: (endpoint: string, params?: Record<string, string>) => Promise<unknown>;
  requestWithPaymentRaw: (endpoint: string, body: unknown) => Promise<unknown>;
};

export function registerSearchTool(server: McpServer): void {
  server.registerTool(
    "blockrun_search",
    {
      description: `Grok Live Search — real-time web + X/Twitter + news with AI-summarized results and citations. ~$0.025 per source.

Common shape:
- body: { query: "...", sources: ["web","x","news"], maxResults: 10, fromDate: "YYYY-MM-DD", toDate: "YYYY-MM-DD" }

\`sources\` accepts any subset of ["web","x","news"] (defaults to all three). For tweet-only searches, use ["x"].

Full request shape + worked examples in the \`search\` skill (\`skills/search/SKILL.md\`).`,
      inputSchema: {
        path: z.string().optional().default("").describe("Endpoint sub-path under /v1/search/ (default empty = root /v1/search). Reserved for future surfaces."),
        body: z.any().optional().describe("Request body. At minimum { query: '...' }. Sent as POST."),
      },
    },
    async ({ path, body }) => {
      try {
        const client = getClient() as unknown as RawClient;
        const cleanPath = (path ?? "").replace(/^\/+/, "").replace(/^v1\/search\/?/, "");
        const endpoint = cleanPath ? `/v1/search/${cleanPath}` : "/v1/search";
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
