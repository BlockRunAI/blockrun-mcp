// src/tools/modal.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getClient } from "../utils/wallet.js";
import { formatError } from "../utils/errors.js";

const MODAL_GPU_TYPES = ["T4", "L4", "A10G", "A100", "A100-80GB", "H100"] as const;

type RawRequester = {
  requestWithPaymentRaw: (endpoint: string, body: unknown) => Promise<unknown>;
};

export function registerModalTool(server: McpServer): void {
  server.registerTool(
    "blockrun_modal",
    {
      description: `Run isolated code in a BlockRun-hosted Modal sandbox.

Use this when you need:
- a disposable remote container
- GPU access
- a clean environment that will not affect the local machine
- a safer place to run untrusted or heavy code

Prefer local tools for normal repo work. Modal is best for isolation or remote execution.

Pricing:
- create: $0.01
- exec/status/terminate: $0.001 each`,
      inputSchema: {
        action: z.enum(["create", "exec", "status", "terminate"]).describe(
          "Sandbox action to perform",
        ),
        sandbox_id: z.string().optional().describe("Sandbox ID returned by a previous create"),
        command: z
          .array(z.string())
          .optional()
          .describe('Command array for exec, for example ["python", "-c", "print(2+2)"]'),
        image: z
          .string()
          .optional()
          .describe("Container image for create (default: python:3.11)"),
        timeout: z
          .number()
          .optional()
          .describe("Timeout in seconds for create or exec"),
        cpu: z.number().optional().describe("CPU cores for create"),
        memory: z.number().optional().describe("Memory in MB for create"),
        gpu: z.enum(MODAL_GPU_TYPES).optional().describe("Optional GPU type for create"),
        setup_commands: z
          .array(z.string())
          .optional()
          .describe("Shell commands to run during sandbox setup"),
      },
    },
    async ({ action, sandbox_id, command, image, timeout, cpu, memory, gpu, setup_commands }) => {
      try {
        const llm = getClient();
        const req = llm as unknown as RawRequester;

        let result: unknown;

        switch (action) {
          case "create":
            result = await req.requestWithPaymentRaw("/v1/modal/sandbox/create", {
              image,
              timeout,
              cpu,
              memory,
              gpu,
              setup_commands,
            });
            break;
          case "exec":
            if (!sandbox_id) throw new Error("sandbox_id required for exec action");
            if (!command?.length) throw new Error("command array required for exec action");
            result = await req.requestWithPaymentRaw("/v1/modal/sandbox/exec", {
              sandbox_id,
              command,
              timeout,
            });
            break;
          case "status":
            if (!sandbox_id) throw new Error("sandbox_id required for status action");
            result = await req.requestWithPaymentRaw("/v1/modal/sandbox/status", { sandbox_id });
            break;
          case "terminate":
            if (!sandbox_id) throw new Error("sandbox_id required for terminate action");
            result = await req.requestWithPaymentRaw("/v1/modal/sandbox/terminate", {
              sandbox_id,
            });
            break;
          default:
            throw new Error(`Unknown action: ${String(action)}`);
        }

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result as Record<string, unknown>,
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: formatError(errMsg) }],
          isError: true,
        };
      }
    },
  );
}
