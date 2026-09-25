import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

/** The name of the in-process MCP server; Claude sees its tools as `mcp__bridge__<tool>`. */
export const nestedWriterServerName = "bridge";

/** The part of a writing task an executor hands to a nested writer. */
export interface NestedWriterBrief {
  assignment: string;
  context?: string | undefined;
  expectedResult: string;
}

/** A refusal the bridge composed for the executor, such as for an uncommitted worktree. */
export class NestedWriterRefusal extends Error {}

/**
 * The nested writers the bridge runs for one execution. Each is a separate
 * Claude Code process that the bridge starts in its own worktree, so the
 * bridge, not the prompt, decides where it works. Reports are JSON values the
 * executor receives as they are.
 */
export interface NestedWriterHost {
  /** Binds a worktree and branch, starts the writer, and returns its report. Refusals throw NestedWriterRefusal. */
  start(brief: NestedWriterBrief): Promise<unknown>;
  /** Waits until the writers (by default all of this execution's) have ended and returns their reports. */
  wait(writerIds?: string[]): Promise<unknown[]>;
  /** How many writers are running. */
  running(): number;
  /** Calls `listener` whenever a writer ends; returns a function that removes it. */
  onEnded(listener: () => void): () => void;
}

const text = (value: unknown): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
});

/** The tool result for a failed call: only messages the bridge composed reach Claude. */
function refusal(error: unknown, fallback: string): CallToolResult {
  const message = error instanceof NestedWriterRefusal ? error.message : fallback;
  return { isError: true, content: [{ type: "text", text: message }] };
}

/**
 * The in-process MCP server that gives an executor its nested writers. Starting
 * returns at once so writers run concurrently: Claude Code runs an MCP tool call
 * in parallel with others only when the tool is read-only, which starting a
 * writer is not. Waiting is read-only and may take as long as the writers.
 */
export function nestedWriterServer(host: NestedWriterHost): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: nestedWriterServerName,
    alwaysLoad: true,
    tools: [
      tool(
        "start_nested_writer",
        "Start a nested writer: a separate Claude Code run that the bridge places in a new Git worktree on its own GitFlow branch, starting from the commit your worktree's HEAD points to. Commit the state it should start from first; a worktree with uncommitted changes is refused. Returns at once with the writer's ID, branch, baseline, and worktree path while it works. The writer commits to its branch and never touches your worktree; you merge or cherry-pick its branch yourself.",
        {
          assignment: z.string().min(1).describe("A self-contained brief for the nested writer."),
          context: z.string().optional().describe("Material the nested writer needs."),
          expectedResult: z.string().min(1).describe("What the nested writer should deliver."),
        },
        async (brief) => {
          try {
            return text(await host.start(brief));
          } catch (error) {
            return refusal(error, "The bridge could not start the nested writer.");
          }
        },
        { annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
      ),
      tool(
        "wait_nested_writers",
        "Wait until nested writers have ended and return their reports: status, branch, baseline, worktree path, commits, changed files, and their structured result with checks, or the error of a failed writer. Waits for the given writerIds, or for every nested writer you started.",
        {
          writerIds: z
            .array(z.string().min(1))
            .optional()
            .describe("Writers to wait for; defaults to all you started."),
        },
        async ({ writerIds }) => {
          try {
            return text({ writers: await host.wait(writerIds) });
          } catch (error) {
            return refusal(error, "The bridge could not report the nested writers.");
          }
        },
        { annotations: { readOnlyHint: true, openWorldHint: false } },
      ),
    ],
  });
}
