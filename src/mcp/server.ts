import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ServiceConnection } from "../ipc.ts";
import { connectService } from "../service/launcher.ts";
import {
  followUpSchema,
  outputSchema,
  respondSchema,
  resultSchema,
  startSchema,
  waitSchema,
} from "../service/tasks.ts";
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
        "Start a delegated task. mode read-only (default): Claude Code inspects the project's shared checkout. mode write: Claude changes files and commits in a new Git worktree on its own task branch from a committed baseline (refused with dirty_parent when the checkout has uncommitted changes and no baseline is given). Both return a structured result (summary, evidence, failures, remaining work; writing tasks add checks and the workspace). Returns task and execution identifiers immediately while Claude works in the background, independent of this connection. Repeating a call with the same requestKey and arguments returns the existing task instead of starting another; reusing the key with different arguments fails. Claude receives only the assignment, context, and expected result given here. The service runs at most its configured number of executions at once; a task beyond that stays queued with reason waiting_for_slot and starts, in order, when a slot frees. In read-only tasks Claude may engage nested read-only agents for independent subtasks and incorporates their work into its result.",
      inputSchema: startSchema.shape,
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    (args) => call("start_task", args),
  );
  server.registerTool(
    "list_tasks",
    {
      title: "List delegated tasks",
      description:
        "List this caller's delegated tasks in a project with their current status, and the service's execution slots across all tasks (slots): limit (most executions running at once; null while config.json is invalid), running, and queued (executions waiting for a free slot).",
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
        "Current status of a task, its executions, and its requests: queued (reason waiting_for_slot while the service runs its limit of executions, with detail.position in line and detail.limit), running (reason waiting_for_capacity while Claude waits for subscription capacity, waiting_for_children while nested agents Claude started still run after its turn, or needs_input while Claude waits for an answer to detail.requestId), completed, failed (reason authentication, subscription_limit, invalid_request, or provider_error, with an error message and action), or interrupted (the service stopped while it ran). Each execution lists the nested agents Claude Code reported (nested), with their status, summary, and how their end is known (termination). requests lists Claude's questions and permission requests with their state (pending, answered, expired), whether they can still be answered (live), and, for live ones, the responseShape respond_to_request expects.",
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
        "The durable result of a task's original execution, or of executionId: summary, evidence, failures, remainingWork, and the workspace used. result is null until the execution completes; a failed or cancelled writing execution still returns the commits and changed files of its retained worktree as a top-level workspace, paged like a result. At most maxChars characters of result text are returned. When the result is longer, truncated.next gives the part and offset where it was cut; calling task_result again with them returns the following parts (summary, then each evidence, failure, and remaining-work item, marked complete: false when cut) until no truncated.next remains. Reading does not consume the result.",
      inputSchema: resultSchema.shape,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => call("task_result", args),
  );

  server.registerTool(
    "wait_task",
    {
      title: "Wait for a delegated task",
      description:
        "Wait up to timeoutSeconds for one execution to finish or become blocked (waiting for subscription capacity, or needs_input when Claude asks something, which ends a wait at once); waiting for nested agents or for a free slot is still progress, so the wait continues. The execution is the one given, or the task's latest at call time, and the response names it. Returns at once for finished executions. A timeout returns the current state with timedOut: true and never stops the task. lastEventSeq tells whether new output exists for read_output.",
      inputSchema: waitSchema.shape,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => call("wait_task", args),
  );
  server.registerTool(
    "read_output",
    {
      title: "Read a delegated task's progress",
      description:
        "Read progress events of an execution after a cursor: status changes, Claude's messages, the tools it calls, and the final summary. Bounded by limit and maxChars; pass nextCursor as after to continue, also after reconnecting. An event cut to fit maxChars is marked truncated; read it in full with after set to its seq minus 1, limit 1, and a larger maxChars. Only the newest events of long executions are kept; the durable result is never affected.",
      inputSchema: outputSchema.shape,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => call("read_output", args),
  );

  server.registerTool(
    "send_followup",
    {
      title: "Send a follow-up to a delegated task",
      description:
        "Continue the task's Claude session with a follow-up message, as a new execution with its own identifier and result; the original result is never replaced. If an execution of the task is active, the follow-up is queued behind it (delivery: queued) and starts when it ends; if the service runs its limit of executions, it waits for a slot (delivery: queued, reason waiting_for_slot). Follow-ups never steer a running turn. Retrying with the same requestKey returns the same execution; a different message with that key fails. If the session cannot be resumed, the execution fails with reason session_unavailable instead of starting an unrelated conversation.",
      inputSchema: followUpSchema.shape,
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    (args) => call("send_followup", args),
  );
  server.registerTool(
    "cancel_task",
    {
      title: "Cancel a delegated task",
      description:
        "Cancel the task's unfinished executions: queued follow-ups at once, the running execution by asking Claude Code to stop its nested agents and then stopping Claude Code. Returns cancellation: confirmed once Claude Code has exited, requested if termination could not be confirmed yet, or none_active when nothing was running; each execution's final status and nested agents are listed (an execution that finished first keeps its result). controlGap discloses nested agents Claude Code did not report stopping. Safe to repeat.",
      inputSchema: {
        project: z.string().describe("Absolute path of the Git checkout the task belongs to."),
        taskId: z.string().describe("Task identifier returned by start_task."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    (args) => call("cancel_task", args),
  );

  server.registerTool(
    "respond_to_request",
    {
      title: "Answer a delegated task's request",
      description:
        'Answer a request Claude is waiting on, listed under requests in task_status while the execution is running with reason needs_input. A question takes { answers } with one answer per question, keyed exactly as responseShape shows it (the displayed question text, with " (question N)" appended when an earlier question displays the same text); a permission request for an MCP tool call takes { decision: "allow" | "deny", message? }. Claude continues as soon as the response arrives. Repeating the same response returns the recorded outcome (repeated: true) without applying it again; a different response to an answered request fails. A request whose Claude session is no longer running (live: false, state expired) cannot be answered; send a follow-up instead.',
      inputSchema: respondSchema.shape,
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
    },
    (args) => call("respond_to_request", args),
  );

  // Codex closing stdin ends this entry point; the service and its work continue.
  process.stdin.once("end", () => process.exit(0));
  await server.connect(new StdioServerTransport());
}
