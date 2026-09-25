import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ServiceConnection } from "../ipc.ts";
import { connectService } from "../service/launcher.ts";
import { startSchema } from "../service/tasks.ts";
import type { StatePaths } from "../state.ts";
import metadata from "../../package.json" with { type: "json" };

/**
 * The stdio MCP entry point Codex launches. It holds no task state: every tool
 * forwards to the background service, which it starts on demand.
 */
export async function runMcpServer(paths: StatePaths, cliPath: string): Promise<void> {
  // Tasks belong to a logical caller, not to this connection, so a restarted
  // Codex finds the tasks it started earlier.
  const caller = process.env.CODEX_CLAUDE_BRIDGE_CALLER || "codex";
  let connection: Promise<ServiceConnection> | undefined;
  const service = async () => {
    const current = await connection?.catch(() => undefined);
    if (!current || current.closed) connection = connectService(paths, cliPath, caller);
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

  const project = z.string().describe("Absolute path of the Git checkout the task belongs to.");
  const taskId = z.string().describe("Task identifier returned by start_task.");

  server.registerTool(
    "start_task",
    {
      title: "Delegate a task to Claude",
      description:
        "Start a read-only delegated task: Claude Code inspects the project's shared checkout and returns a structured result (summary, evidence, failures, remaining work). Returns task and execution identifiers immediately while Claude works in the background, independent of this connection. Repeating a call with the same requestKey and arguments returns the existing task instead of starting another; reusing the key with different arguments fails. Claude receives only the assignment, context, and expected result given here.",
      inputSchema: startSchema.shape,
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    (args) => call("start_task", args),
  );
  server.registerTool(
    "list_tasks",
    {
      title: "List delegated tasks",
      description: "List this caller's delegated tasks in a project with their current status.",
      inputSchema: { project },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => call("list_tasks", args),
  );
  server.registerTool(
    "task_status",
    {
      title: "Check a delegated task",
      description:
        "Current status of a task and its executions: queued, running (reason waiting_for_capacity while Claude waits for subscription capacity), completed, failed (reason authentication, subscription_limit, invalid_request, or provider_error, with an error message and action), or interrupted (the service stopped while it ran).",
      inputSchema: { project, taskId },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => call("task_status", args),
  );
  server.registerTool(
    "task_result",
    {
      title: "Read a delegated task's result",
      description:
        "The durable result of a task's original execution, or of executionId: summary, evidence, failures, remainingWork, and the workspace used. result is null until the execution completes. Reading does not consume the result.",
      inputSchema: {
        project,
        taskId,
        executionId: z
          .string()
          .optional()
          .describe("A specific execution; defaults to the original."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => call("task_result", args),
  );

  // Codex closing stdin ends this entry point; the service and its work continue.
  process.stdin.once("end", () => process.exit(0));
  await server.connect(new StdioServerTransport());
}
