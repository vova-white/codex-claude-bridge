import {
  query,
  type CanUseTool,
  type PermissionResult,
  type SDKAssistantMessageError,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { redact } from "../redact.ts";
import {
  claudeFailure,
  claudeProcess,
  classifyCredentials,
  credentialAction,
  withTimeout,
} from "./readiness.ts";
import { processIdentity, type ProcessIdentity } from "./processes.ts";
import {
  nestedWriterServer,
  nestedWriterServerName,
  type NestedWriterHost,
} from "./nested-writers.ts";

const initializeTimeoutMs = 60_000;
/** How long cancellation waits for Claude Code to report stopped nested agents before ending its process. */
const nestedStopGraceMs = 5_000;
/** Continues the executor's session when its nested writers end after its turn did. */
const nestedWritersEndedPrompt = `<nested-writers-ended>
Every nested writer you started has ended. Call wait_nested_writers to collect their reports, assemble their branches into yours or report the conflicts, and finish with the structured result.
</nested-writers-ended>`;

/** Why an execution failed, in terms the parent agent can act on. */
export type FailureReason =
  | "authentication"
  | "subscription_limit"
  | "invalid_request"
  | "session_unavailable"
  | "workspace_error"
  | "provider_error";

export interface ExecutionRequest {
  executable: string;
  env: NodeJS.ProcessEnv;
  extraArgs: Record<string, string>;
  cwd: string;
  prompt: string;
  /** Appended to Claude Code's system prompt: the task profile and reporting contract. */
  guidance: string;
  disallowedTools: string[];
  /**
   * MCP servers whose tool calls need the parent agent's approval. Every other
   * tool the task allows runs without asking.
   */
  approvalServers: readonly string[];
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** The shape Claude must report its final answer in. */
  resultSchema: z.ZodType;
  /** Session to continue; the prompt is sent only if Claude Code can resume it. */
  resume?: string;
  /** Aborting stops Claude Code; the outcome is then `cancelled`. */
  signal: AbortSignal;
  secrets: readonly string[];
  /** Nested writers the executor may start through the bridge's in-process MCP tools. */
  nestedWriters?: NestedWriterHost;
}

/** A nested agent Claude Code reported starting through its Agent tool. */
export interface NestedStart {
  taskId: string;
  /** The Agent tool call that started it. */
  toolUseId?: string;
  /** The Agent tool call of the nested agent it runs inside; absent when the executor started it. */
  parentToolUseId?: string;
  description: string;
  agentType?: string;
  background: boolean;
  depth?: number;
}

/**
 * How a nested agent ended. `reported`: Claude Code reported it. `process_exit`:
 * it was still running when Claude Code's process exited, which ends every agent
 * inside that process. `unconfirmed`: the process did not exit either.
 */
export interface NestedEnd {
  status: "completed" | "failed" | "stopped" | "unknown";
  summary?: string;
  termination: "reported" | "process_exit" | "unconfirmed";
}

export interface ExecutionObserver {
  /**
   * Called once Claude Code's process is spawned, before it receives anything,
   * so a later service can tell whether it still runs.
   */
  launched(process: ProcessIdentity): void;
  session(id: string): void;
  /** Called with the reset time while Claude Code waits for subscription capacity, and with undefined once it proceeds. */
  capacity(waiting: { resetsAt?: number } | undefined): void;
  /** Text Claude writes while it works. */
  message(text: string): void;
  /** A tool Claude calls, with its input as Claude sent it, and the nested agent that called it, if any. */
  toolCall(name: string, input: unknown, nestedTaskId?: string): void;
  nestedStarted(task: NestedStart): void;
  /** A nested agent's progress summary, when Claude Code gives one. */
  nestedProgress(taskId: string, summary: string): void;
  nestedEnded(taskId: string, end: NestedEnd): void;
  /**
   * Called with the number of running nested agents while the executor's turn
   * has finished before them, and with 0 once they have all ended. The
   * execution then continues until the executor's next result.
   */
  waitingForChildren(count: number): void;
  /**
   * Claude waits for the parent agent: an answer to its question or a decision
   * on a tool call. Resolves with the parent's response, or with undefined if
   * the request ended unanswered. `signal` aborts once no response may reach
   * Claude any more: Claude Code withdrew the request, cancellation began, or
   * the execution ended.
   */
  request(request: PendingRequest, signal: AbortSignal): Promise<RequestResponse | undefined>;
}

/** What Claude asks the parent agent for, with Claude's own request content. */
export type PendingRequest = { toolName: string; sessionId?: string } & (
  | { kind: "question"; questions: unknown }
  | {
      kind: "permission";
      mcpServer: string;
      input: Record<string, unknown>;
      title?: string;
      description?: string;
    }
);

export type RequestResponse =
  /** One answer per question, in the order Claude asked them. */
  { answers: string[] } | { decision: "allow" | "deny"; message?: string };

type TurnOutcome =
  | { status: "completed"; text: string; structured?: unknown }
  | { status: "cancelled" }
  | {
      status: "failed";
      reason: FailureReason;
      message: string;
      action: string;
      detail?: { resetsAt?: number };
    };

/** `processExited` confirms that the Claude Code process is gone, whatever the outcome. */
export type ExecutionOutcome = TurnOutcome & { processExited: boolean };

/** The shape Claude Code must return its final answer in. */
export const reportedResult = z.object({
  summary: z.string().describe("The answer or outcome of the assignment."),
  evidence: z.array(z.string()).describe("What was inspected or run, and what it showed."),
  failures: z.array(z.string()).describe("Anything that failed or could not be verified."),
  remainingWork: z.array(z.string()).describe("Work left for the parent agent."),
});
/** The result of a writing task also reports the checks run to verify the change. */
export const writingResult = reportedResult.extend({
  checks: z
    .array(
      z.object({
        command: z.string().describe("The command or check that was run."),
        outcome: z.enum(["passed", "failed", "not_run"]),
        details: z.string().optional().describe("What failed, or why it was not run."),
      }),
    )
    .describe("Checks run to verify the change and their outcomes."),
});

const accountErrors = new Set<SDKAssistantMessageError>([
  "authentication_failed",
  "oauth_org_not_allowed",
  "account_on_hold",
  "verification_required",
  "billing_error",
  "cloud_credential_error",
]);

const assistantErrors = new Set<SDKAssistantMessageError>([
  ...accountErrors,
  "rate_limit",
  "overloaded",
  "invalid_request",
  "model_not_found",
  "server_error",
  "unknown",
  "max_output_tokens",
]);
const resultSubtypes = new Set([
  "success",
  "error_during_execution",
  "error_max_turns",
  "error_max_budget_usd",
  "error_max_structured_output_retries",
]);
const sessionIdentifier = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How a turn ended, from the assistant error code and result subtype the bridge knows. */
function turnFailure(error: string | undefined, subtype: string): string {
  const reported =
    error === undefined
      ? ""
      : assistantErrors.has(error as SDKAssistantMessageError)
        ? `reported ${error} and `
        : "reported an unrecognized error and ";
  const ending =
    subtype === "success"
      ? "an error result"
      : resultSubtypes.has(subtype)
        ? subtype
        : "an unrecognized result";
  return `Claude Code ${reported}ended the turn with ${ending}`;
}

function failureReason(error: SDKAssistantMessageError | undefined): FailureReason {
  if (error && accountErrors.has(error)) return "authentication";
  if (error === "rate_limit") return "subscription_limit";
  if (error === "model_not_found" || error === "invalid_request") return "invalid_request";
  return "provider_error";
}

/** Streaming input for one prompt, sent only after the session is verified. */
class Input implements AsyncIterable<SDKUserMessage> {
  private readonly messages: SDKUserMessage[] = [];
  private wake?: () => void;
  private closed = false;

  push(text: string): void {
    this.messages.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
    });
    this.wake?.();
  }

  close(): void {
    this.closed = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      const next = this.messages.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => (this.wake = resolve));
    }
  }
}

/**
 * The MCP server of a tool call. Claude Code names the server when it asks;
 * older versions only encode it in the tool name as `mcp__<server>__<tool>`,
 * with characters outside [A-Za-z0-9_-] replaced by underscores.
 */
function mcpServerOf(
  tool: string,
  options: { mcpServer?: { name: string } },
  servers: readonly string[],
): string | undefined {
  if (options.mcpServer) return options.mcpServer.name;
  return servers.find((name) => tool.startsWith(`mcp__${name.replace(/[^A-Za-z0-9_-]/g, "_")}__`));
}

/** Turns the parent agent's response into Claude Code's permission decision. */
function permissionResult(
  input: Record<string, unknown>,
  response: RequestResponse | undefined,
): PermissionResult {
  if (!response) {
    return { behavior: "deny", message: "No one answered this request before the task ended." };
  }
  if ("answers" in response) {
    // Claude Code looks answers up by its original question text; the parent answered by position, since duplicate texts are told apart.
    const questions = Array.isArray(input.questions) ? (input.questions as unknown[]) : [];
    const answers = Object.fromEntries(
      questions.map((item, index) => [
        String((item as { question?: unknown }).question),
        response.answers[index] ?? "",
      ]),
    );
    return { behavior: "allow", updatedInput: { ...input, answers } };
  }
  return response.decision === "allow"
    ? { behavior: "allow", updatedInput: input }
    : { behavior: "deny", message: response.message ?? "The parent agent denied this tool call." };
}

/**
 * Runs one prompt through Claude Code. The session's credential source and the
 * requested model are checked before the prompt is sent, so a rejected
 * execution never reaches a model. A failure is described only by values the
 * bridge knows (the reason, an assistant error code, a result subtype, the
 * process's exit, a timeout, a reset time): text from Claude Code, the SDK, or
 * an MCP server can quote credentials in forms no filter recognizes.
 *
 * The outcome is the executor's first successful result while none of the
 * nested agents Claude Code reported is running. A result that arrives while
 * some still run only moves the execution to waiting: Claude Code runs another
 * turn for each nested agent that finishes, and that later result carries the
 * incorporated work. Cancellation asks Claude Code to stop running nested
 * agents before it ends the process, and wins over a failure it races. Every
 * outcome is returned only after Claude Code's process has exited or could
 * not be stopped.
 *
 * Nested writers run outside Claude Code, so it does not start a turn when they
 * end: a result that arrives while some run waits for them too, and once they
 * have all ended the executor is prompted to collect and assemble their work.
 * A result is not final while a writer that ended has reached the executor
 * neither through wait_nested_writers nor through that prompt.
 */
export async function runExecution(
  request: ExecutionRequest,
  observer: ExecutionObserver,
): Promise<ExecutionOutcome> {
  const input = new Input();
  const abort = new AbortController();
  if (request.signal.aborted) return { status: "cancelled", processExited: true };
  const claude = claudeProcess((pid) => observer.launched(processIdentity(pid)));
  /** Running nested agents by task ID, with the Agent tool calls that started them. */
  const nested = new Map<string, string | undefined>();
  const nestedChanged = new Set<() => void>();
  /** The nested agent whose Agent tool call each tool call belongs to. */
  const toolUseParents = new Map<string, string>();
  let waiting = false;
  const writers = request.nestedWriters;
  const runningChildren = () => nested.size + (writers?.running() ?? 0);
  const childEnded = () => {
    if (!waiting) return;
    const count = runningChildren();
    observer.waitingForChildren(count);
    waiting = count > 0;
  };
  const endNested = (taskId: string, end: NestedEnd) => {
    if (!nested.delete(taskId)) return;
    observer.nestedEnded(taskId, end);
    for (const listener of nestedChanged) listener();
    childEnded();
  };
  /** Whether the executor's turn ended while nested writers ran. */
  let writersPending = false;
  /** Ended writers the ended notice has told the executor about. */
  const announced = new Set<string>();
  /** Sends the ended notice if some ended writer's report reached the executor neither way; returns whether it did. */
  const announceWriters = () => {
    const unannounced = writers?.unreported().filter((id) => !announced.has(id)) ?? [];
    if (unannounced.length === 0) return false;
    for (const id of unannounced) announced.add(id);
    input.push(nestedWritersEndedPrompt);
    return true;
  };
  const stopWatchingWriters = writers?.onEnded(() => {
    childEnded();
    if (!writersPending || writers.running() > 0 || request.signal.aborted) return;
    writersPending = false;
    announceWriters();
  });
  const allEnded = (taskIds: string[]) =>
    new Promise<void>((resolve) => {
      const check = () => {
        if (taskIds.some((taskId) => nested.has(taskId))) return;
        nestedChanged.delete(check);
        resolve();
      };
      nestedChanged.add(check);
      check();
    });
  // Nested agents are asked to stop first, so their ends are reported rather than inferred.
  const cancel = () => {
    const taskIds = [...nested.keys()];
    if (taskIds.length === 0) return abort.abort();
    const stopped = Promise.all(
      taskIds.map((taskId) => session.stopTask(taskId).catch(() => undefined)),
    ).then(() => allEnded(taskIds));
    const grace = new Promise((resolve) => setTimeout(resolve, nestedStopGraceMs));
    void Promise.race([stopped, grace]).then(() => abort.abort());
  };
  request.signal.addEventListener("abort", cancel, { once: true });
  /** Whether Claude Code reported a session; its ID is kept only in the known UUID form. */
  let sessionStarted = false;
  let sessionId: string | undefined;
  // Ends the parent's open requests once the execution is over.
  const ended = new AbortController();
  const canUseTool: CanUseTool = async (tool, toolInput, options) => {
    const server = mcpServerOf(tool, options, request.approvalServers);
    const identity = { toolName: tool, ...(sessionId ? { sessionId } : {}) };
    let pending: PendingRequest;
    if (tool === "AskUserQuestion") {
      pending = { ...identity, kind: "question", questions: toolInput.questions };
    } else if (server !== undefined && request.approvalServers.includes(server)) {
      pending = {
        ...identity,
        kind: "permission",
        mcpServer: server,
        input: toolInput,
        ...(options.title ? { title: options.title } : {}),
        ...(options.description ? { description: options.description } : {}),
      };
    } else {
      return { behavior: "allow", updatedInput: toolInput };
    }
    // Cancellation ends the request at once, before nested agents are given time to stop.
    const response = await observer.request(
      pending,
      AbortSignal.any([options.signal, request.signal, ended.signal]),
    );
    return permissionResult(toolInput, response);
  };
  const failed = (
    reason: FailureReason,
    description: string,
    action: string,
    detail?: { resetsAt: number },
  ): TurnOutcome => ({
    status: "failed",
    reason,
    message: redact(
      `Execution failed with ${reason}: ${description}.${detail ? ` Subscription capacity resets at ${new Date(detail.resetsAt * 1000).toISOString()}.` : ""}`,
      request.secrets,
    ),
    action,
    ...(detail ? { detail } : {}),
  });
  // Failure diagnostics keep none of Claude Code's output; once a session exists,
  // the user can read that output in Claude Code itself.
  const fullOutput = () =>
    `To see Claude Code's full output, run \`claude\` in ${request.cwd} and enter ${sessionId ? `\`/resume ${sessionId}\`` : "`/resume` and pick the task's session"}`;
  const withFullOutput = (action: string) =>
    sessionStarted ? `${action} ${fullOutput()}.` : action;
  const inspect = () =>
    sessionStarted
      ? `${fullOutput()}, then start a new task with a new request key once the problem is fixed.`
      : `Run \`claude\` in ${request.cwd} to see whether Claude Code starts and is signed in, then start a new task with a new request key.`;
  const session = query({
    prompt: input,
    options: {
      pathToClaudeCodeExecutable: request.executable,
      cwd: request.cwd,
      env: request.env,
      extraArgs: request.extraArgs,
      abortController: abort,
      // Spawning here gives the bridge the process itself, so its exit can be
      // confirmed and a failure described by it rather than by its output.
      spawnClaudeCodeProcess: claude.spawn,
      ...(request.model ? { model: request.model } : {}),
      ...(request.effort ? { effort: request.effort } : {}),
      ...(request.resume ? { resume: request.resume } : {}),
      ...(writers ? { mcpServers: { [nestedWriterServerName]: nestedWriterServer(writers) } } : {}),
      permissionMode: "default",
      disallowedTools: request.disallowedTools,
      canUseTool,
      // Claude Code validates --json-schema with a draft-07 validator.
      outputFormat: {
        type: "json_schema",
        schema: z.toJSONSchema(request.resultSchema, { target: "draft-7" }),
      },
      systemPrompt: { type: "preset", preset: "claude_code", append: request.guidance },
    },
  });
  const turn = async (): Promise<TurnOutcome> => {
    try {
      let init;
      try {
        init = await withTimeout(session.initializationResult(), initializeTimeoutMs);
      } catch (error) {
        if (request.resume && /no conversation found/i.test((error as Error).message)) {
          return failed(
            "session_unavailable",
            `Claude Code cannot resume ${sessionIdentifier.test(request.resume) ? `session ${request.resume}` : "the task's session"}; the message was not sent`,
            "Start a new task with the context the follow-up needs; the earlier results stay available.",
          );
        }
        throw error;
      }
      const credentials = classifyCredentials(init.account);
      if (!credentials.verified) {
        return failed(
          "authentication",
          `Claude Code is not using a verified subscription login (source: ${credentials.source}); the brief was not sent`,
          credentialAction(credentials) ?? inspect(),
        );
      }
      if (
        request.model &&
        !init.models.some(
          (model) => model.value === request.model || model.resolvedModel === request.model,
        )
      ) {
        return failed(
          "invalid_request",
          `model ${request.model} is not available in Claude Code; the brief was not sent`,
          "Choose a model from the readiness `models`, or omit `model` to use Claude Code's default.",
        );
      }

      if (request.signal.aborted) return { status: "cancelled" };
      input.push(request.prompt);
      let lastError: SDKAssistantMessageError | undefined;
      let resetsAt: number | undefined;
      for await (const message of session) {
        if (message.type === "system" && message.subtype === "init") {
          sessionStarted = true;
          if (sessionIdentifier.test(message.session_id)) {
            sessionId = message.session_id;
            observer.session(sessionId);
          }
        } else if (message.type === "rate_limit_event") {
          const info = message.rate_limit_info;
          if (info.status === "rejected") {
            resetsAt = info.resetsAt;
            observer.capacity(resetsAt === undefined ? {} : { resetsAt });
          } else {
            observer.capacity(undefined);
          }
        } else if (message.type === "system" && message.subtype === "task_started") {
          if (message.task_type !== "local_agent" || message.ambient) continue;
          nested.set(message.task_id, message.tool_use_id);
          const parent = message.tool_use_id && toolUseParents.get(message.tool_use_id);
          observer.nestedStarted({
            taskId: message.task_id,
            ...(message.tool_use_id ? { toolUseId: message.tool_use_id } : {}),
            ...(parent ? { parentToolUseId: parent } : {}),
            description: message.description,
            ...(message.subagent_type ? { agentType: message.subagent_type } : {}),
            background: message.is_backgrounded === true,
            ...(message.spawn_depth === undefined ? {} : { depth: message.spawn_depth }),
          });
        } else if (message.type === "system" && message.subtype === "task_progress") {
          if (nested.has(message.task_id) && message.summary) {
            observer.nestedProgress(message.task_id, message.summary);
          }
        } else if (message.type === "system" && message.subtype === "task_notification") {
          endNested(message.task_id, {
            status: message.status,
            ...(message.summary ? { summary: message.summary } : {}),
            termination: "reported",
          });
        } else if (message.type === "assistant") {
          if (message.error) lastError = message.error;
          const caller = message.parent_tool_use_id ?? undefined;
          const callerTask = caller
            ? [...nested].find(([, toolUseId]) => toolUseId === caller)?.[0]
            : undefined;
          for (const block of message.message.content) {
            if (block.type === "text" && block.text.trim()) {
              observer.message(block.text);
            } else if (block.type === "tool_use") {
              if (caller) toolUseParents.set(block.id, caller);
              observer.toolCall(block.name, block.input, callerTask);
            }
          }
        } else if (message.type === "result") {
          if (request.signal.aborted) return { status: "cancelled" };
          if (message.subtype === "success" && !message.is_error) {
            if (runningChildren() > 0) {
              waiting = true;
              writersPending = (writers?.running() ?? 0) > 0;
              observer.waitingForChildren(runningChildren());
              continue;
            }
            if (announceWriters()) continue;
            return {
              status: "completed",
              text: message.result,
              ...(message.structured_output === undefined
                ? {}
                : { structured: message.structured_output }),
            };
          }
          const reason = failureReason(lastError);
          const description = turnFailure(lastError, message.subtype);
          if (reason === "authentication") {
            return failed(
              reason,
              description,
              withFullOutput("Run `claude`, then `/login` with your Claude subscription account."),
            );
          }
          if (reason === "subscription_limit") {
            return failed(
              reason,
              description,
              withFullOutput(
                "Wait until subscription capacity resets, then start a new task with a new request key.",
              ),
              typeof resetsAt === "number" && !Number.isNaN(new Date(resetsAt * 1000).getTime())
                ? { resetsAt }
                : undefined,
            );
          }
          return failed(reason, description, inspect());
        }
      }
      if (request.signal.aborted) return { status: "cancelled" };
      if (waiting) {
        return failed(
          "provider_error",
          "Claude Code exited while nested agents were still running; the assignment is incomplete",
          inspect(),
        );
      }
      return failed(
        "provider_error",
        claudeFailure(undefined, await claude.exit(), initializeTimeoutMs),
        inspect(),
      );
    } catch (error) {
      if (request.signal.aborted) return { status: "cancelled" };
      return failed(
        "provider_error",
        claudeFailure(error, await claude.exit(), initializeTimeoutMs),
        inspect(),
      );
    } finally {
      request.signal.removeEventListener("abort", cancel);
      stopWatchingWriters?.();
    }
  };
  const settled = await turn();
  ended.abort();
  input.close();
  session.close();
  const processExited = await claude.stop();
  abort.abort();
  // A cancellation that arrives while the bridge waits for Claude Code to exit
  // still ends the execution as cancelled; a completed turn stays completed.
  const outcome: TurnOutcome =
    settled.status === "failed" && request.signal.aborted ? { status: "cancelled" } : settled;
  waiting = false;
  for (const taskId of nested.keys()) {
    endNested(
      taskId,
      processExited
        ? { status: "stopped", termination: "process_exit" }
        : { status: "unknown", termination: "unconfirmed" },
    );
  }
  return { ...outcome, processExited };
}
