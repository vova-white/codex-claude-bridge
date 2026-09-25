import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ServiceConnection } from "../ipc.ts";
import { connectService } from "../service/launcher.ts";
import type { StatePaths } from "../state.ts";
import metadata from "../../package.json" with { type: "json" };

/**
 * The stdio MCP entry point Codex launches. It holds no task state: every tool
 * forwards to the background service, which it starts on demand.
 */
export async function runMcpServer(paths: StatePaths, cliPath: string): Promise<void> {
  let connection: Promise<ServiceConnection> | undefined;
  const service = async () => {
    const current = await connection?.catch(() => undefined);
    if (!current || current.closed) connection = connectService(paths, cliPath);
    return connection!;
  };
  // Start or attach to the service as soon as Codex loads the plugin.
  void service().catch(() => {});

  const call = async (method: string, params: unknown): Promise<CallToolResult> => {
    try {
      const result = await (await service()).request(method, params);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: (error as Error).message }] };
    }
  };

  const server = new McpServer({ name: "claude-bridge", version: metadata.version });
  server.registerTool(
    "readiness",
    {
      title: "Check Claude readiness",
      description:
        "Check whether Claude Code can run delegated work: Claude Code version and Agent SDK compatibility, subscription credential source, available models and options, Git support for an optional project, and configured MCP integrations. Does not send a prompt to Claude. Lists the operations this bridge supports.",
      inputSchema: {
        project: z
          .string()
          .optional()
          .describe("Absolute path of the Git checkout that delegated work would use."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ project }) => call("readiness", { project }),
  );

  // Codex closing stdin ends this entry point; the service and its work continue.
  process.stdin.once("end", () => process.exit(0));
  await server.connect(new StdioServerTransport());
}
