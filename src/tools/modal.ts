// src/tools/modal.ts
//
// Modal sandbox — isolated remote code execution (optional GPU). Path-based
// passthrough. Full action catalog (create / exec / status / terminate) and
// GPU type / image / timeout details live in the modal skill.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getClient } from "../utils/wallet.js";
import { formatError, extractErrorMessage } from "../utils/errors.js";

type RawClient = {
  getWithPaymentRaw: (endpoint: string, params?: Record<string, string>) => Promise<unknown>;
  requestWithPaymentRaw: (endpoint: string, body: unknown) => Promise<unknown>;
};

export function registerModalTool(server: McpServer): void {
  server.registerTool(
    "blockrun_modal",
    {
      description: `Run isolated code in a BlockRun-hosted Modal sandbox — disposable remote container, optional GPU.

Use when you need: a clean ephemeral environment, GPU access (T4/L4/A10G/A100/A100-80GB/H100), or a safer place for untrusted code. Prefer local tools for normal repo work.

Common paths (all POST):
- sandbox/create     — body: { image?, timeout?, cpu?, memory?, gpu?, setup_commands? }    ($0.01)
- sandbox/exec       — body: { sandbox_id, command: ["python","-c","..."], timeout? }      ($0.001)
- sandbox/status     — body: { sandbox_id }                                                ($0.001)
- sandbox/terminate  — body: { sandbox_id }                                                ($0.001)

Full action shapes + GPU type details in the \`modal\` skill.`,
      inputSchema: {
        path: z.string().describe("Endpoint under /v1/modal/, e.g. 'sandbox/create', 'sandbox/exec'"),
        body: z.any().optional().describe("JSON body. Sent as POST."),
      },
    },
    async ({ path, body }) => {
      try {
        const client = getClient() as unknown as RawClient;
        const cleanPath = path.replace(/^\/+/, "").replace(/^v1\/modal\//, "");
        const endpoint = `/v1/modal/${cleanPath}`;
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
