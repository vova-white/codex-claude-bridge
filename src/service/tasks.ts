import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  reportedResult,
  runExecution,
  writingResult,
  type ExecutionObserver,
  type ExecutionOutcome,
  type PendingRequest,
  type RequestResponse,
} from "../claude/execution.ts";
import {
  NestedWriterRefusal,
  type NestedWriterBrief,
  type NestedWriterHost,
} from "../claude/nested-writers.ts";
import { claudeEnvironment, claudeExecutable, mcpConfigArgs } from "../claude/readiness.ts";
import { type BridgeConfig, configSecrets } from "../config.ts";
import { errorOrigin, redactContent } from "../redact.ts";
import { ServiceError } from "../ipc.ts";
import type { StatePaths } from "../state.ts";
import {
  addWorktree,
  branchTypes,
  changedPaths,
  checkoutState,
  hasUncommittedChanges,
  repositoryRoot,
  resolveCommit,
  taskBranch,
  worktreeChanges,
} from "../workspace.ts";

export const effortLevels = ["low", "medium", "high", "xhigh", "max"] as const;

/** Arguments of start_task, shared by the MCP tool definition and the service. */
export const startSchema = z.object({
  project: z.string().min(1).describe("Absolute path of the Git checkout the task belongs to."),
  requestKey: z
    .string()
    .min(1)
    .max(200)
    .describe("Caller-chosen key that identifies this request; reuse it to retry safely."),
  assignment: z.string().min(1).describe("The focused brief for Claude."),
  context: z
    .string()
    .optional()
    .describe("Relevant material Claude needs; nothing else is shared."),
  expectedResult: z.string().min(1).describe("What Claude should deliver."),
  model: z
    .string()
    .min(1)
    .optional()
    .describe("A model value from readiness; defaults to Claude Code's default model."),
  effort: z.enum(effortLevels).optional().describe("Reasoning effort the model supports."),
  mode: z
    .enum(["read-only", "write"])
    .default("read-only")
    .describe(
      "Task profile: read-only inspects the shared checkout; write changes files in a new Git worktree on its own task branch.",
    ),
  baseline: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Write mode: the committed revision to start from. Defaults to HEAD, but is required when the checkout has uncommitted changes, which the child would not see.",
    ),
  branchType: z
    .enum(branchTypes)
    .optional()
    .describe("Write mode: GitFlow prefix of the task branch (default feature)."),
});
export type StartRequest = z.infer<typeof startSchema>;

/** Upper bound of one wait_task call, below the plugin's MCP tool timeout. */
const maxWaitSeconds = 300;
/** Diagnostics retention per execution, independent of the durable result. */
const maxEventsPerExecution = 2000;
const maxStoredEventChars = 16_000;

const taskLookup = z.object({ project: z.string().min(1), taskId: z.string().min(1) });

/** Arguments of wait_task. */
export const waitSchema = z.object({
  project: z.string().min(1).describe("Absolute path of the Git checkout the task belongs to."),
  taskId: z.string().min(1).describe("Task identifier returned by start_task."),
  executionId: z
    .string()
    .min(1)
    .optional()
    .describe("Execution to wait for; defaults to the task's latest execution at call time."),
  timeoutSeconds: z
    .number()
    .int()
    .min(0)
    .max(maxWaitSeconds)
    .default(60)
    .describe(
      `Longest time to wait, up to ${maxWaitSeconds} s. Timing out does not stop the task.`,
    ),
});

/** Arguments of send_followup. */
export const followUpSchema = z.object({
  project: z.string().min(1).describe("Absolute path of the Git checkout the task belongs to."),
  taskId: z.string().min(1).describe("Task identifier returned by start_task."),
  requestKey: z
    .string()
    .min(1)
    .max(200)
    .describe("Caller-chosen key for this follow-up; reuse it to retry safely."),
  message: z.string().min(1).describe("The follow-up instruction or question for Claude."),
});

/** Arguments of read_output. */
export const outputSchema = z.object({
  project: z.string().min(1).describe("Absolute path of the Git checkout the task belongs to."),
  taskId: z.string().min(1).describe("Task identifier returned by start_task."),
  executionId: z
    .string()
    .min(1)
    .optional()
    .describe("Execution to read; defaults to the task's latest execution."),
  after: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe("Cursor: return events with a sequence number greater than this (nextCursor)."),
  limit: z.number().int().min(1).max(200).default(50).describe("Most events to return."),
  maxChars: z
    .number()
    .int()
    .min(200)
    .max(maxStoredEventChars)
    .default(8000)
    .describe("Most characters of event text to return in total."),
});
/** Arguments of task_result. */
export const resultSchema = z.object({
  project: z.string().min(1).describe("Absolute path of the Git checkout the task belongs to."),
  taskId: z.string().min(1).describe("Task identifier returned by start_task."),
  executionId: z
    .string()
    .min(1)
    .optional()
    .describe("A specific execution; defaults to the original."),
  maxChars: z
    .number()
    .int()
    .min(200)
    .max(maxStoredEventChars)
    .default(12_000)
    .describe("Most characters of result text to return."),
  part: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Continue from this result part (from truncated.next); returns parts."),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Character offset within that part (from truncated.next)."),
});
const projectLookup = z.object({ project: z.string().min(1) });

/** Arguments of respond_to_request. */
export const respondSchema = z.object({
  project: z.string().min(1).describe("Absolute path of the Git checkout the task belongs to."),
  taskId: z.string().min(1).describe("Task identifier returned by start_task."),
  requestId: z.string().min(1).describe("Request identifier from task_status."),
  response: z
    .union([
      z.strictObject({
        decision: z.enum(["allow", "deny"]),
        message: z.string().min(1).optional().describe("Why; Claude sees it with a denial."),
      }),
      z.strictObject({
        answers: z
          .record(z.string(), z.string().min(1))
          .describe("An answer for each question, keyed by the question text."),
      }),
    ])
    .describe(
      "For a permission request { decision, message? }; for a question { answers }. The request's responseShape shows the expected form.",
    ),
});

const expiredNote = "The Claude session that asked is no longer running; send a follow-up instead.";

/**
 * Tools a read-only task never gets. Claude Code applies these session deny
 * rules to nested agents too, whatever tools their definitions list.
 */
const readOnlyDisallowedTools = ["Edit", "Write", "NotebookEdit"];
/** Most commits and changed files a result lists, and the longest commit subject kept. */
const maxListedChanges = 500;
const maxSubjectChars = 1_000;
/** Writing tasks get every tool except nested agents, which could not be held to the worktree. */
const writingDisallowedTools = ["Agent"];

interface WorkspaceRow {
  task_id: string;
  path: string;
  branch: string;
  baseline: string;
  parent_dirty: number;
  state: string;
  created_at: string;
}

interface NestedWriterRow {
  id: string;
  execution_id: string;
  brief: string;
  path: string;
  branch: string;
  baseline: string;
  status: string;
  reason: string | null;
  session_id: string | null;
  outcome: string | null;
  process_exited: number | null;
  created_at: string;
  ended_at: string | null;
}

/** The running nested writers of one execution, and the means to stop them when it ends. */
type NestedWriters = NestedWriterHost & { stopAll(): Promise<void> };

interface TaskRow {
  id: string;
  project: string;
  caller: string;
  request_key: string;
  request_hash: string;
  mode: string;
  request: string;
  session_id: string | null;
  created_at: string;
}

/**
 * What a running execution waits for: requests the caller must answer, oldest
 * first; subscription capacity; and nested agents still running after the
 * executor's turn.
 */
interface Waits {
  requests: Set<string>;
  capacity?: { resetsAt?: number };
  runningNested: number;
}

interface RequestRow {
  id: string;
  task_id: string;
  execution_id: string;
  session_id: string | null;
  /** The nested writer that asked; absent when the executor did. */
  writer_id: string | null;
  tool_name: string;
  kind: "question" | "permission";
  payload: string;
  response_shape: string;
  state: "pending" | "answered" | "expired";
  /** The response as the parent sees it, redacted. */
  response: string | null;
  /** Identifies the response as given, so a repeat can be recognized. */
  response_hash: string | null;
  created_at: string;
  resolved_at: string | null;
}

interface NestedRow {
  task_id: string;
  tool_use_id: string | null;
  parent_tool_use_id: string | null;
  description: string;
  agent_type: string | null;
  background: number;
  depth: number | null;
  status: string;
  summary: string | null;
  termination: string | null;
  started_at: string;
  ended_at: string | null;
}

interface ExecutionRow {
  id: string;
  task_id: string;
  ordinal: number;
  status: string;
  reason: string | null;
  detail: string | null;
  error: string | null;
  session_id: string | null;
  result: string | null;
  events_pruned: number;
  kind: string;
  input: string | null;
  request_key: string | null;
  request_hash: string | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
}

/** How long a cancel call waits for Claude Code to exit before reporting the request as pending. */
const cancelConfirmationMs = 20_000;
const terminalStatuses = ["completed", "failed", "cancelled", "interrupted"];
/** Reasons a running execution cannot progress on its own; entering one ends a wait. */
const blockedReasons = new Set(["waiting_for_capacity", "needs_input"]);

function parse<T>(schema: z.ZodType<T>, params: unknown): T {
  const parsed = schema.safeParse(params ?? {});
  if (!parsed.success) throw new ServiceError("invalid_arguments", z.prettifyError(parsed.error));
  return parsed.data;
}

const now = () => new Date().toISOString();

function prompt(request: NestedWriterBrief): string {
  return [
    `<assignment>\n${request.assignment}\n</assignment>`,
    request.context ? `<context>\n${request.context}\n</context>` : "",
    `<expected-result>\n${request.expectedResult}\n</expected-result>`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function readOnlyGuidance(root: string): string {
  return `You are the child agent carrying out a task delegated by Codex, the parent agent. Work autonomously on the assignment in the user message; the parent reviews your result.

This task uses the read-only profile on a shared checkout at ${root}. Do not create, modify, or delete files, change Git state, or install anything; the Edit, Write, and NotebookEdit tools are unavailable, and shell commands are for inspection only. The bridge compares the checkout before and after the task and reports any change to the parent.

You may start nested agents with the Agent tool for independent research or review subtasks that can run in parallel, but only when the expected gain in quality or elapsed time outweighs the cost of briefing them, the extra usage, and reconciling their findings. Keep small, sequential, or tightly coupled work yourself. Nested agents have the same read-only restrictions. Wait for every nested agent you start, including background ones, and incorporate their findings into your result: you remain accountable for it, and the parent sees the task as waiting while nested agents run.

Work without asking whenever you can: make reasonable assumptions, state them, and list anything unresolved as remaining work. When a decision genuinely needs the user or the parent, ask with AskUserQuestion; the parent answers while you wait. Some MCP tools need the parent's approval before each call; if a call is denied, continue without it and report what you could not do.

Finish with the structured result: summary (the answer or outcome), evidence (what you inspected or ran and what it showed), failures (anything that failed or could not be verified), and remainingWork (what is left for the parent).`;
}

function writingGuidance(workspace: WorkspaceRow, parent: string): string {
  return `You are the child agent carrying out a task delegated by Codex, the parent agent. Work autonomously on the assignment in the user message; the parent reviews your result.

This task uses the writing profile in its own Git worktree at ${workspace.path}, on branch ${workspace.branch}, starting from commit ${workspace.baseline}. Work only inside this worktree: other checkouts, including the parent's at ${parent}, belong to other agents. The worktree isolates Git changes; it is not a sandbox.

Make the changes the assignment needs. Install dependencies and run the checks that fit your changes. Commit your work to ${workspace.branch} with Conventional Commits messages, following the repository's own guidance. Do not push or open pull requests: publication is not enabled for this task.

Claude Code's Agent tool is not available, because its agents would share your worktree. To split independent changes among nested writers working in parallel, use the bridge's start_nested_writer tool. Each nested writer is a separate Claude Code run that the bridge starts in its own worktree, on its own branch, from the commit your HEAD points to: commit the state it should start from first, as a worktree with uncommitted changes is refused. The tool returns at once; wait_nested_writers returns each writer's branch, baseline, commits, changed files, checks, and result. Assemble their work yourself: merge or cherry-pick each branch into ${workspace.branch}, run the checks that matter, and report in failures any conflict you could not resolve, naming the branch. You remain accountable for the result; your task is not complete while nested writers run or before you have collected their reports, and if your turn ends first you are prompted to assemble their work once they have all ended.

Use nested writers only when changes are independent and large enough that working in parallel outweighs the cost: each is a full Claude Code session on the same subscription, and you brief it, review its work, and merge it. Keep small, sequential, or tightly coupled changes yourself. Nested writers cannot start nested writers, and the bridge does not limit how many you start, so start only as many as the work justifies.

Work without asking whenever you can: make reasonable assumptions, state them, and list anything unresolved as remaining work. When a decision genuinely needs the user or the parent, ask with AskUserQuestion; the parent answers while you wait. Some MCP tools need the parent's approval before each call; if a call is denied, continue without it and report what you could not do.

Finish with the structured result: summary (what you changed and why), evidence (what you inspected or ran and what it showed), failures (anything that failed or could not be verified), remainingWork (what is left for the parent), and checks (each check you ran and whether it passed).`;
}

function nestedWriterGuidance(writer: NestedWriterRow, executor: WorkspaceRow): string {
  return `You are a nested writer: a Claude agent working on part of a task that Codex delegated to another Claude agent, the executor, which assigned you this part and will assemble your work. Work autonomously on the assignment in the user message.

You work in your own Git worktree at ${writer.path}, on branch ${writer.branch}, starting from commit ${writer.baseline}. Work only inside this worktree: other checkouts, including the executor's at ${executor.path}, belong to other agents. The worktree isolates Git changes; it is not a sandbox.

Make the changes the assignment needs. Install dependencies and run the checks that fit your changes. Commit your work to ${writer.branch} with Conventional Commits messages, following the repository's own guidance. Do not merge other branches, push, or open pull requests: the executor integrates your branch.

Nested agents are not available: do all of the work yourself.

Work without asking whenever you can: make reasonable assumptions, state them, and list anything unresolved as remaining work. When a decision genuinely needs the user or Codex, ask with AskUserQuestion; Codex answers while you wait. Some MCP tools need Codex's approval before each call; if a call is denied, continue without it and report what you could not do.

Finish with the structured result: summary (what you changed and why), evidence (what you inspected or ran and what it showed), failures (anything that failed or could not be verified), remainingWork (what is left for the executor), and checks (each check you ran and whether it passed).`;
}

const ending = () => new NestedWriterRefusal("The task is ending; no nested writer was started.");

/**
 * Owns delegated tasks: their durable identity, their executions, and the
 * Claude Code processes running them. Tasks belong to a project and a logical
 * caller; nothing is visible outside that scope.
 */
export class TaskService {
  private readonly db: DatabaseSync;
  private readonly paths: StatePaths;
  private readonly config: () => BridgeConfig;
  private readonly log: (message: string) => void;
  /** Emits an execution ID whenever that execution's state changes. */
  private readonly changes = new EventEmitter();
  /** Executions this service is running, with the means to stop them. */
  private readonly running = new Map<
    string,
    { controller: AbortController; done: Promise<void> }
  >();
  /** Tasks whose next queued execution is about to start. */
  private readonly launching = new Set<string>();
  /** Requests Claude is waiting on in this process, with the means to answer them. */
  /** What each execution running in this process waits for; its reason is derived from it. */
  private readonly waits = new Map<string, Waits>();
  private readonly live = new Map<
    string,
    { resolve: (response: RequestResponse | undefined) => void; secrets: readonly string[] }
  >();

  constructor(
    db: DatabaseSync,
    paths: StatePaths,
    config: () => BridgeConfig,
    log: (message: string) => void,
  ) {
    this.db = db;
    this.paths = paths;
    this.config = config;
    this.log = log;
    this.changes.setMaxListeners(0);
  }

  /**
   * A new service never inherits live Claude Code processes, so executions the
   * previous service left unfinished cannot be running any more.
   */
  interruptUnfinished(): void {
    const unfinished = this.db
      .prepare("SELECT id FROM executions WHERE status IN ('queued', 'running')")
      .all() as { id: string }[];
    for (const { id } of unfinished) {
      this.db
        .prepare(
          `UPDATE executions SET status = 'interrupted', reason = 'service_restarted', detail = NULL, ended_at = ?
           WHERE id = ?`,
        )
        .run(now(), id);
      this.record(
        id,
        "status",
        "Interrupted: the bridge service stopped while this execution ran.",
      );
    }
    this.db
      .prepare(
        "UPDATE nested_tasks SET status = 'unknown', termination = 'unconfirmed', ended_at = ? WHERE status = 'running'",
      )
      .run(now());
    this.db
      .prepare(
        "UPDATE nested_writers SET status = 'interrupted', reason = 'service_restarted', ended_at = ? WHERE status = 'running'",
      )
      .run(now());
    if (unfinished.length > 0) {
      this.log(`marked ${unfinished.length} unfinished execution(s) interrupted`);
    }
    const pending = this.db.prepare("SELECT id FROM requests WHERE state = 'pending'").all() as {
      id: string;
    }[];
    for (const { id } of pending) this.expire(id);
  }

  async start(caller: string, params: unknown) {
    const request = parse(startSchema, params);
    const project = await this.projectRoot(request.project);
    this.config(); // Fail before accepting work that could not run.
    const { requestKey, project: _path, ...intent } = request;
    const hash = createHash("sha256").update(JSON.stringify(intent)).digest("hex");

    const existing = () => {
      const task = this.db
        .prepare("SELECT * FROM tasks WHERE project = ? AND caller = ? AND request_key = ?")
        .get(project, caller, requestKey) as TaskRow | undefined;
      if (!task) return undefined;
      if (task.request_hash !== hash) {
        throw new ServiceError(
          "request_key_conflict",
          `Request key "${requestKey}" already started task ${task.id} with different arguments. Use a new request key for different work.`,
        );
      }
      const execution = this.execution(task.id, 1);
      return {
        taskId: task.id,
        executionId: execution.id,
        status: execution.status,
        created: false,
      };
    };
    const earlier = existing();
    if (earlier) return earlier;

    let workspace: { baseline: string; parentDirty: boolean } | undefined;
    if (request.mode === "write") {
      const parentDirty = await hasUncommittedChanges(project);
      if (parentDirty && !request.baseline) {
        throw new ServiceError(
          "dirty_parent",
          `${project} has uncommitted changes, which a writing task would not see: its worktree starts from a commit. Commit the changes the child needs, or pass baseline (for example "HEAD") to start from that commit without them.`,
        );
      }
      const baseline = await resolveCommit(project, request.baseline ?? "HEAD");
      if (!baseline) {
        throw new ServiceError(
          "invalid_baseline",
          `${request.baseline ?? "HEAD"} does not name a commit in ${project}.`,
        );
      }
      workspace = { baseline, parentDirty };
    } else if (request.baseline || request.branchType) {
      // Absent options also keep the request identity of read-only tasks as it was.
      throw new ServiceError(
        "invalid_arguments",
        "baseline and branchType apply only to writing tasks; read-only tasks inspect the shared checkout as it is.",
      );
    }

    const taskId = `task_${randomUUID()}`;
    const executionId = `exec_${randomUUID()}`;
    const createdAt = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // A concurrent request with the same key may have been accepted while this
      // one checked the checkout.
      const accepted = existing();
      if (accepted) {
        this.db.exec("ROLLBACK");
        return accepted;
      }
      this.db
        .prepare(
          `INSERT INTO tasks (id, project, caller, request_key, request_hash, mode, request, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          taskId,
          project,
          caller,
          requestKey,
          hash,
          request.mode,
          JSON.stringify(intent),
          createdAt,
        );
      this.db
        .prepare(
          `INSERT INTO executions (id, task_id, ordinal, status, created_at) VALUES (?, ?, 1, 'queued', ?)`,
        )
        .run(executionId, taskId, createdAt);
      if (workspace) {
        // The worktree is bound to the task before any execution can edit.
        this.db
          .prepare(
            `INSERT INTO workspaces (task_id, path, branch, baseline, parent_dirty, state, created_at)
             VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
          )
          .run(
            taskId,
            join(this.paths.worktrees, taskId),
            taskBranch(request.branchType ?? "feature", request.assignment, taskId),
            workspace.baseline,
            workspace.parentDirty ? 1 : 0,
            createdAt,
          );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.record(executionId, "status", "Accepted.");
    // Accepted intent is durable before any Claude Code process starts.
    this.schedule(taskId);
    return { taskId, executionId, status: "queued", created: true };
  }

  async list(caller: string, params: unknown) {
    const { project } = parse(projectLookup, params);
    const root = await this.projectRoot(project);
    const tasks = this.db
      .prepare("SELECT * FROM tasks WHERE project = ? AND caller = ? ORDER BY created_at, id")
      .all(root, caller) as unknown as TaskRow[];
    return {
      tasks: tasks.map((task) => {
        const latest = this.latestExecution(task.id);
        const intent = JSON.parse(task.request) as { assignment: string };
        return {
          taskId: task.id,
          status: latest.status,
          ...(latest.reason ? { reason: latest.reason } : {}),
          mode: task.mode,
          assignment:
            intent.assignment.length > 200
              ? `${intent.assignment.slice(0, 200)}…`
              : intent.assignment,
          createdAt: task.created_at,
        };
      }),
    };
  }

  async status(caller: string, params: unknown) {
    const { project, taskId } = parse(taskLookup, params);
    const task = await this.task(caller, project, taskId);
    const executions = this.db
      .prepare("SELECT * FROM executions WHERE task_id = ? ORDER BY ordinal")
      .all(task.id) as unknown as ExecutionRow[];
    const latest = executions.at(-1)!;
    const intent = JSON.parse(task.request) as Omit<StartRequest, "project" | "requestKey">;
    const requests = this.db
      .prepare("SELECT * FROM requests WHERE task_id = ? ORDER BY created_at, rowid")
      .all(task.id) as unknown as RequestRow[];
    const workspace = this.workspace(task.id);
    return {
      taskId: task.id,
      project: task.project,
      mode: task.mode,
      ...executionState(latest),
      ...(task.session_id ? { sessionId: task.session_id } : {}),
      ...(workspace ? { workspace: workspaceReport(workspace) } : {}),
      createdAt: task.created_at,
      request: intent,
      executions: executions.map((execution) => ({
        executionId: execution.id,
        ordinal: execution.ordinal,
        ...executionState(execution),
        ...this.nested(execution.id),
        ...this.nestedWriterReports(execution.id),
        ...(execution.started_at ? { startedAt: execution.started_at } : {}),
        ...(execution.ended_at ? { endedAt: execution.ended_at } : {}),
      })),
      requests: requests.map((request) => this.requestView(request)),
    };
  }

  /**
   * Answers a request Claude is waiting on. The response reaches Claude once:
   * repeating it returns the recorded outcome, and a different response to an
   * answered request fails. A request whose execution has ended cannot be answered.
   */
  async respond(caller: string, params: unknown) {
    const { project, taskId, requestId, response } = parse(respondSchema, params);
    const task = await this.task(caller, project, taskId);
    const request = this.db
      .prepare("SELECT * FROM requests WHERE id = ? AND task_id = ?")
      .get(requestId, task.id) as RequestRow | undefined;
    if (!request) {
      throw new ServiceError("not_found", `Task ${task.id} has no request ${requestId}.`);
    }
    if (request.state === "answered") {
      if (request.response_hash !== responseHash(this.checkResponse(request, response).given)) {
        throw new ServiceError(
          "request_already_answered",
          `Request ${requestId} was already answered with a different response, which cannot be replaced.`,
        );
      }
      return { taskId: task.id, ...this.requestView(request), repeated: true };
    }
    const live = this.live.get(requestId);
    if (!live) {
      this.expire(requestId);
      throw new ServiceError("request_expired", `Request ${requestId} has expired: ${expiredNote}`);
    }
    const { given, answer } = this.checkResponse(request, response);
    const shown = redactStrings(given, (text) => redactContent(text, live.secrets));
    this.db
      .prepare(
        "UPDATE requests SET state = 'answered', response = ?, response_hash = ?, resolved_at = ? WHERE id = ? AND state = 'pending'",
      )
      .run(JSON.stringify(shown), responseHash(given), now(), requestId);
    this.live.delete(requestId);
    this.record(
      request.execution_id,
      "status",
      `Request ${requestId} answered${"decision" in answer ? ` (${answer.decision})` : ""}.`,
    );
    this.block(request.execution_id, (waits) => waits.requests.delete(requestId));
    live.resolve(answer);
    const answered = this.db
      .prepare("SELECT * FROM requests WHERE id = ?")
      .get(requestId) as unknown as RequestRow;
    return { taskId: task.id, ...this.requestView(answered), repeated: false };
  }

  /**
   * The durable result of an execution, bounded by maxChars and read from the
   * stored result itself. Without a cursor it returns the result's usual shape,
   * cut where the budget ends; `truncated.next` then continues from the first
   * character not shown, returning `parts` until nothing is left.
   */
  async result(caller: string, params: unknown) {
    const { project, taskId, executionId, maxChars, part, offset } = parse(resultSchema, params);
    const task = await this.task(caller, project, taskId);
    const execution = executionId
      ? this.executionById(task.id, executionId)
      : this.execution(task.id, 1);
    const state = { taskId: task.id, executionId: execution.id, ...executionState(execution) };
    if (!execution.result) return { ...state, result: null };
    const stored = JSON.parse(execution.result) as Record<string, unknown> & StoredResult;
    const parts = resultParts(stored);
    const page = readParts(parts, part ?? 0, offset ?? 0, maxChars);
    const next = page.next ? { part: page.next.part, offset: page.next.offset } : undefined;
    const truncation = next
      ? {
          truncated: {
            next,
            totalParts: parts.length,
            note: "Call task_result again with part and offset from next to read the rest.",
          },
        }
      : {};
    if (part !== undefined || offset !== undefined) {
      return { ...state, parts: page.parts, ...truncation };
    }
    const rest = Object.fromEntries(
      Object.entries(stored).filter(
        ([key]) =>
          !["summary", "evidence", "failures", "remainingWork", "checks", "workspace"].includes(
            key,
          ),
      ),
    );
    const shown = (field: string) => page.parts.filter((item) => item.field === field);
    const texts = (field: string) => shown(field).map((item) => item.text);
    return {
      ...state,
      result: {
        summary: texts("summary")[0] ?? "",
        evidence: texts("evidence"),
        failures: texts("failures"),
        remainingWork: texts("remainingWork"),
        ...(stored.checks ? { checks: shownChecks(page.parts, stored.checks) } : {}),
        ...rest,
        ...(stored.workspace
          ? {
              workspace: {
                ...stored.workspace,
                ...(stored.workspace.commits
                  ? {
                      commits: shown("commits").map((item) => ({
                        sha: item.sha,
                        subject: item.text,
                      })),
                    }
                  : {}),
                ...(stored.workspace.changedFiles ? { changedFiles: texts("changedFiles") } : {}),
              },
            }
          : {}),
      },
      ...truncation,
    };
  }

  /**
   * Adds a follow-up to the task's Claude session as a new execution. It runs
   * after any active execution of the task; a retry with the same request key
   * returns the same execution.
   */
  async followUp(caller: string, params: unknown) {
    const { project, taskId, requestKey, message } = parse(followUpSchema, params);
    const task = await this.task(caller, project, taskId);
    const hash = createHash("sha256").update(message).digest("hex");
    const existing = this.db
      .prepare("SELECT * FROM executions WHERE task_id = ? AND request_key = ?")
      .get(task.id, requestKey) as ExecutionRow | undefined;
    if (existing) {
      if (existing.request_hash !== hash) {
        throw new ServiceError(
          "request_key_conflict",
          `Request key "${requestKey}" already sent a different follow-up to task ${task.id} (execution ${existing.id}). Use a new request key for a different message.`,
        );
      }
      return {
        taskId: task.id,
        executionId: existing.id,
        ...executionState(existing),
        created: false,
      };
    }
    const active = this.db
      .prepare(
        "SELECT id FROM executions WHERE task_id = ? AND status IN ('queued', 'running') ORDER BY ordinal DESC LIMIT 1",
      )
      .get(task.id) as { id: string } | undefined;
    const executionId = `exec_${randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO executions (id, task_id, ordinal, status, created_at, kind, input, request_key, request_hash)
         VALUES (?, ?, (SELECT MAX(ordinal) + 1 FROM executions WHERE task_id = ?), 'queued', ?, 'follow-up', ?, ?, ?)`,
      )
      .run(executionId, task.id, task.id, now(), message, requestKey, hash);
    this.record(
      executionId,
      "status",
      active ? `Queued behind execution ${active.id}.` : "Accepted.",
    );
    this.schedule(task.id);
    return {
      taskId: task.id,
      executionId,
      status: "queued",
      terminal: false,
      created: true,
      // Follow-ups never steer a running turn: they wait for it and then continue the session.
      delivery: active ? "queued" : "starting",
      ...(active ? { queuedBehind: active.id } : {}),
    };
  }

  /**
   * Cancels the task's unfinished executions: queued ones at once, running ones
   * by stopping Claude Code. Cancellation is confirmed only once the process has
   * exited; repeating it is harmless.
   */
  async cancel(caller: string, params: unknown) {
    const { project, taskId } = parse(taskLookup, params);
    const task = await this.task(caller, project, taskId);
    const active = this.db
      .prepare(
        "SELECT * FROM executions WHERE task_id = ? AND status IN ('queued', 'running') ORDER BY ordinal",
      )
      .all(task.id) as unknown as ExecutionRow[];
    const requestedAt = now();
    const stopping: Promise<void>[] = [];
    for (const execution of active) {
      if (execution.status === "queued") {
        const cancelled = this.update(
          execution.id,
          { status: "cancelled", reason: "cancelled", ended_at: requestedAt },
          "queued",
        );
        if (cancelled) this.record(execution.id, "status", "Cancelled before it started.");
        continue;
      }
      const run = this.running.get(execution.id);
      if (run) {
        run.controller.abort();
        stopping.push(run.done);
      }
    }
    await Promise.race([
      Promise.all(stopping),
      new Promise((resolve) => setTimeout(resolve, cancelConfirmationMs)),
    ]);
    const executions = active.map((execution) => this.executionById(task.id, execution.id));
    const views = executions.map((execution) => ({
      executionId: execution.id,
      ...executionState(execution),
      ...this.nested(execution.id),
      ...this.nestedWriterReports(execution.id),
    }));
    // Every terminal state is written after the Claude Code processes of the
    // execution and its nested writers exited, or records processExited: false
    // when that could not be confirmed.
    const confirmed =
      executions.every(
        (execution) =>
          terminalStatuses.includes(execution.status) &&
          (JSON.parse(execution.detail ?? "{}") as { processExited?: boolean }).processExited !==
            false,
      ) &&
      views
        .flatMap((view) => view.nestedWriters ?? [])
        .every((writer) => writer.status !== "running" && writer.processExited !== false);
    const unreported = views
      .flatMap((view) => view.nested ?? [])
      .filter((nested) => nested.termination !== undefined && nested.termination !== "reported");
    return {
      taskId: task.id,
      cancellation: active.length === 0 ? "none_active" : confirmed ? "confirmed" : "requested",
      executions: views,
      ...(unreported.length > 0
        ? {
            controlGap: `Claude Code did not report stopping ${unreported.length} nested agent(s). Those with termination process_exit ended with its process; unconfirmed ones may still run. The bridge does not control work nested agents started outside Claude Code, such as background commands.`,
          }
        : {}),
    };
  }

  /**
   * Waits for one execution, pinned at call time, to finish or to become blocked,
   * for at most the timeout. Timing out reports the current state and never
   * stops the execution.
   */
  async wait(caller: string, params: unknown) {
    const { project, taskId, executionId, timeoutSeconds } = parse(waitSchema, params);
    const task = await this.task(caller, project, taskId);
    const pinned = executionId
      ? this.executionById(task.id, executionId)
      : this.latestExecution(task.id);
    const initialReason = pinned.reason;
    const deadline = Date.now() + timeoutSeconds * 1000;
    for (;;) {
      const current = this.executionById(task.id, pinned.id);
      // A pending request needs the caller's answer, so it ends a wait at once;
      // a capacity wait ends a wait only when it begins.
      const blocked =
        current.reason === "needs_input" ||
        (current.reason !== initialReason && blockedReasons.has(current.reason ?? ""));
      const remaining = deadline - Date.now();
      if (terminalStatuses.includes(current.status) || blocked || remaining <= 0) {
        return {
          taskId: task.id,
          executionId: current.id,
          timedOut: !terminalStatuses.includes(current.status) && !blocked,
          ...executionState(current),
          lastEventSeq: this.lastEventSeq(current.id),
        };
      }
      await this.nextChange(current.id, remaining);
    }
  }

  /**
   * Reads an execution's progress events after a cursor, bounded by count and
   * characters. An event longer than the remaining budget is cut and marked, and
   * can be read in full by asking for that one event with a larger budget.
   */
  async readOutput(caller: string, params: unknown) {
    const request = parse(outputSchema, params);
    const task = await this.task(caller, request.project, request.taskId);
    const execution = request.executionId
      ? this.executionById(task.id, request.executionId)
      : this.latestExecution(task.id);
    const rows = this.db
      .prepare(
        "SELECT seq, at, kind, text FROM events WHERE execution_id = ? AND seq > ? ORDER BY seq LIMIT ?",
      )
      .all(execution.id, request.after, request.limit + 1) as unknown as {
      seq: number;
      at: string;
      kind: string;
      text: string;
    }[];
    const events: { seq: number; at: string; kind: string; text: string; truncated?: object }[] =
      [];
    let budget = request.maxChars;
    for (const row of rows.slice(0, request.limit)) {
      if (row.text.length <= budget) {
        events.push(row);
        budget -= row.text.length;
        continue;
      }
      if (events.length === 0) {
        events.push({
          ...row,
          text: row.text.slice(0, budget),
          truncated: { shownChars: budget, totalChars: row.text.length },
        });
      }
      break;
    }
    const nextCursor = events.at(-1)?.seq ?? request.after;
    const first = this.db
      .prepare("SELECT MIN(seq) AS seq FROM events WHERE execution_id = ?")
      .get(execution.id) as { seq: number | null };
    return {
      taskId: task.id,
      executionId: execution.id,
      ...executionState(execution),
      events,
      nextCursor,
      hasMore: rows.some((row) => row.seq > nextCursor),
      ...(execution.events_pruned > 0
        ? {
            retention: {
              prunedEvents: execution.events_pruned,
              firstAvailableSeq: first.seq,
              note: `Only the newest ${maxEventsPerExecution} events of an execution are kept; the result is not affected.`,
            },
          }
        : {}),
    };
  }

  /**
   * Checks that a response fits the request. Returns it as given, in a stable
   * form, and as Claude receives it: answers go by question position, because
   * the parent answers the question texts as displayed, possibly redacted.
   */
  private checkResponse(
    request: RequestRow,
    response: z.infer<typeof respondSchema>["response"],
  ): { given: object; answer: RequestResponse } {
    if (request.kind === "permission") {
      if (!("decision" in response)) {
        throw new ServiceError(
          "invalid_arguments",
          `Request ${request.id} asks for permission; respond with { decision: "allow" | "deny", message? }.`,
        );
      }
      const decision = {
        decision: response.decision,
        ...(response.message ? { message: response.message } : {}),
      };
      return { given: decision, answer: decision };
    }
    const asked = questionTexts(JSON.parse(request.payload));
    if (
      !("answers" in response) ||
      Object.keys(response.answers).length !== asked.length ||
      !asked.every((question) => question in response.answers)
    ) {
      throw new ServiceError(
        "invalid_arguments",
        `Request ${request.id} asks questions; respond with { answers } holding one answer for each of: ${asked.map((question) => JSON.stringify(question)).join(", ")}.`,
      );
    }
    const answers = asked.map((question) => response.answers[question]!);
    return {
      given: {
        answers: Object.fromEntries(asked.map((question, index) => [question, answers[index]])),
      },
      answer: { answers },
    };
  }

  /** A request as status shows it; only a live request can be answered. */
  private requestView(request: RequestRow) {
    const live = request.state === "pending" && this.live.has(request.id);
    return {
      requestId: request.id,
      executionId: request.execution_id,
      ...(request.writer_id ? { writerId: request.writer_id } : {}),
      ...(request.session_id ? { sessionId: request.session_id } : {}),
      kind: request.kind,
      toolName: request.tool_name,
      state: request.state,
      live,
      [request.kind === "question" ? "question" : "action"]: JSON.parse(request.payload),
      ...(live ? { responseShape: JSON.parse(request.response_shape) } : {}),
      ...(request.response ? { response: JSON.parse(request.response) } : {}),
      createdAt: request.created_at,
      ...(request.resolved_at ? { resolvedAt: request.resolved_at } : {}),
      ...(request.state === "expired" ? { note: expiredNote } : {}),
    };
  }

  /**
   * Records what Claude asks the parent and waits for the answer. The request
   * stays live until it is answered or `signal` ends it, which expires it. A
   * nested writer's request belongs to the execution that started the writer.
   */
  private raise(
    executionId: string,
    request: PendingRequest,
    signal: AbortSignal,
    secrets: readonly string[],
    writerId?: string,
  ): Promise<RequestResponse | undefined> {
    const clean = (value: unknown) => redactStrings(value, (text) => redactContent(text, secrets));
    const { kind, toolName, sessionId, ...content } = request;
    const payload = clean(kind === "question" ? content : { toolName, ...content });
    const questions = kind === "question" ? questionTexts(payload) : [];
    const responseShape =
      kind === "question"
        ? {
            answers: Object.fromEntries(
              questions.map((text) => [
                text,
                "an option label (several comma-separated when multiSelect) or your own answer",
              ]),
            ),
          }
        : { decision: "allow | deny", message: "optional: why, shown to Claude" };
    const id = `req_${randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO requests (id, task_id, execution_id, session_id, writer_id, tool_name, kind, payload, response_shape, state, created_at)
         VALUES (?, (SELECT task_id FROM executions WHERE id = ?), ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(
        id,
        executionId,
        executionId,
        sessionId ?? null,
        writerId ?? null,
        toolName,
        kind,
        JSON.stringify(payload),
        JSON.stringify(responseShape),
        now(),
      );
    return new Promise((resolve) => {
      this.live.set(id, { resolve, secrets });
      const asker = writerId ? ` from nested writer ${writerId}` : "";
      this.record(
        executionId,
        "status",
        kind === "question"
          ? `Needs input: request ${id}${asker} asks ${questions.join(" ")}`
          : `Needs input: request ${id}${asker} asks to call ${toolName}.`,
      );
      this.block(executionId, (waits) => waits.requests.add(id));
      if (signal.aborted) this.expire(id);
      else signal.addEventListener("abort", () => this.expire(id), { once: true });
    });
  }

  /** Ends an unanswered request; Claude, if still waiting, is told no one answered. */
  private expire(requestId: string): void {
    const request = this.db
      .prepare("SELECT execution_id FROM requests WHERE id = ?")
      .get(requestId) as { execution_id: string } | undefined;
    const expired =
      this.db
        .prepare(
          "UPDATE requests SET state = 'expired', resolved_at = ? WHERE id = ? AND state = 'pending'",
        )
        .run(now(), requestId).changes > 0;
    const live = this.live.get(requestId);
    this.live.delete(requestId);
    if (expired && request) {
      this.record(request.execution_id, "status", `Request ${requestId} expired unanswered.`);
      this.block(request.execution_id, (waits) => waits.requests.delete(requestId));
    }
    live?.resolve(undefined);
  }

  /**
   * Changes what a running execution waits for and shows the most pressing wait
   * as its reason: a request the caller must answer, then subscription
   * capacity, then nested agents after the executor's turn.
   */
  private block(executionId: string, change: (waits: Waits) => void): void {
    const waits = this.waits.get(executionId);
    if (!waits) return;
    change(waits);
    const [firstRequest] = waits.requests;
    const [reason, detail] =
      firstRequest !== undefined
        ? ["needs_input", { requestId: firstRequest }]
        : waits.capacity
          ? ["waiting_for_capacity", waits.capacity]
          : waits.runningNested > 0
            ? ["waiting_for_children", { runningNested: waits.runningNested }]
            : [null, null];
    const shown = detail === null ? null : JSON.stringify(detail);
    const current = this.db
      .prepare("SELECT reason, detail FROM executions WHERE id = ?")
      .get(executionId) as { reason: string | null; detail: string | null };
    if (current.reason !== reason || current.detail !== shown) {
      this.update(executionId, { reason, detail: shown });
    }
  }

  private async projectRoot(path: string): Promise<string> {
    const root = await repositoryRoot(path);
    if (!root) {
      throw new ServiceError("project_not_git", `${path} is not inside a Git repository.`);
    }
    return root;
  }

  private async task(caller: string, project: string, taskId: string): Promise<TaskRow> {
    const root = await this.projectRoot(project);
    const task = this.db
      .prepare("SELECT * FROM tasks WHERE id = ? AND project = ? AND caller = ?")
      .get(taskId, root, caller) as TaskRow | undefined;
    if (!task) throw new ServiceError("not_found", `No task ${taskId} in ${root} for this caller.`);
    return task;
  }

  private execution(taskId: string, ordinal: number): ExecutionRow {
    return this.db
      .prepare("SELECT * FROM executions WHERE task_id = ? AND ordinal = ?")
      .get(taskId, ordinal) as unknown as ExecutionRow;
  }

  private latestExecution(taskId: string): ExecutionRow {
    return this.db
      .prepare("SELECT * FROM executions WHERE task_id = ? ORDER BY ordinal DESC LIMIT 1")
      .get(taskId) as unknown as ExecutionRow;
  }

  private update(executionId: string, fields: Record<string, string | null>, when = "running") {
    const columns = Object.keys(fields);
    const changed =
      this.db
        .prepare(
          `UPDATE executions SET ${columns.map((column) => `${column} = ?`).join(", ")} WHERE id = ? AND status = ?`,
        )
        .run(...Object.values(fields), executionId, when).changes > 0;
    if (changed) this.changes.emit("change", executionId);
    return changed;
  }

  /** Appends progress output, keeping only the newest events of an execution. */
  private record(executionId: string, kind: string, text: string): void {
    let stored = text;
    if (text.length > maxStoredEventChars) {
      // The marker fits within the limit, so one read_output call can return the whole event.
      const marker = `… [${text.length} characters, the rest not stored]`;
      stored = `${text.slice(0, maxStoredEventChars - marker.length)}${marker}`;
    }
    this.db
      .prepare("INSERT INTO events (execution_id, at, kind, text) VALUES (?, ?, ?, ?)")
      .run(executionId, now(), kind, stored);
    const pruned = this.db
      .prepare(
        `DELETE FROM events WHERE execution_id = ? AND seq <= (
           SELECT seq FROM events WHERE execution_id = ? ORDER BY seq DESC LIMIT 1 OFFSET ?)`,
      )
      .run(executionId, executionId, maxEventsPerExecution).changes;
    if (pruned > 0) {
      this.db
        .prepare("UPDATE executions SET events_pruned = events_pruned + ? WHERE id = ?")
        .run(pruned, executionId);
    }
  }

  /** The nested agents Claude Code reported for an execution, as task_status shows them. */
  private nested(executionId: string) {
    const rows = this.db
      .prepare("SELECT * FROM nested_tasks WHERE execution_id = ? ORDER BY started_at, rowid")
      .all(executionId) as unknown as NestedRow[];
    if (rows.length === 0) return {};
    return {
      nested: rows.map((row) => ({
        taskId: row.task_id,
        ...(row.tool_use_id ? { toolUseId: row.tool_use_id } : {}),
        ...(row.parent_tool_use_id ? { parentToolUseId: row.parent_tool_use_id } : {}),
        description: row.description,
        ...(row.agent_type ? { agentType: row.agent_type } : {}),
        background: row.background === 1,
        ...(row.depth === null ? {} : { depth: row.depth }),
        status: row.status,
        ...(row.summary ? { summary: row.summary } : {}),
        ...(row.termination ? { termination: row.termination } : {}),
        startedAt: row.started_at,
        ...(row.ended_at ? { endedAt: row.ended_at } : {}),
      })),
    };
  }

  private executionById(taskId: string, executionId: string): ExecutionRow {
    const execution = this.db
      .prepare("SELECT * FROM executions WHERE task_id = ? AND id = ?")
      .get(taskId, executionId) as ExecutionRow | undefined;
    if (!execution) {
      throw new ServiceError("not_found", `Task ${taskId} has no execution ${executionId}.`);
    }
    return execution;
  }

  private lastEventSeq(executionId: string): number {
    const row = this.db
      .prepare("SELECT MAX(seq) AS seq FROM events WHERE execution_id = ?")
      .get(executionId) as { seq: number | null };
    return row.seq ?? 0;
  }

  private nextChange(executionId: string, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.changes.off("change", listener);
        resolve();
      };
      const listener = (id: string) => {
        if (id === executionId) done();
      };
      const timer = setTimeout(done, ms);
      this.changes.on("change", listener);
    });
  }

  private workspace(taskId: string): WorkspaceRow | undefined {
    return this.db.prepare("SELECT * FROM workspaces WHERE task_id = ?").get(taskId) as
      | WorkspaceRow
      | undefined;
  }

  /** Creates the task's worktree once; later executions reuse it. */
  private async prepareWorkspace(workspace: WorkspaceRow): Promise<boolean> {
    if (workspace.state === "ready") return true;
    const task = this.db
      .prepare("SELECT project FROM tasks WHERE id = ?")
      .get(workspace.task_id) as {
      project: string;
    };
    try {
      mkdirSync(this.paths.worktrees, { recursive: true, mode: 0o700 });
      await addWorktree(task.project, workspace.path, workspace.branch, workspace.baseline);
    } catch (error) {
      this.log(
        `worktree for ${workspace.task_id} could not be created (${(error as NodeJS.ErrnoException).code ?? "git worktree add failed"})`,
      );
      this.db
        .prepare("UPDATE workspaces SET state = 'failed' WHERE task_id = ?")
        .run(workspace.task_id);
      return false;
    }
    this.db
      .prepare("UPDATE workspaces SET state = 'ready' WHERE task_id = ?")
      .run(workspace.task_id);
    return true;
  }

  /**
   * The nested writers an execution may start. Each is bound to its own
   * worktree and branch, created from the executor's committed HEAD, before its
   * Claude Code process starts there. They stop when the execution is cancelled
   * or ends.
   */
  private nestedWriters(
    executionId: string,
    request: StartRequest,
    executor: WorkspaceRow,
    signal: AbortSignal,
  ): NestedWriters {
    const runs = new Map<string, { controller: AbortController; done: Promise<void> }>();
    const listeners = new Set<() => void>();
    const unreported = new Set<string>();
    let closed = false;
    /** Why writers still running are stopped: the task was cancelled, or the execution ended first. */
    let stopReason = "parent_ended";
    const stop = () => {
      for (const run of runs.values()) run.controller.abort();
    };
    const cancelled = () => {
      stopReason = "cancelled";
      stop();
    };
    signal.addEventListener("abort", cancelled, { once: true });
    const { project } = this.db
      .prepare("SELECT project FROM tasks WHERE id = ?")
      .get(executor.task_id) as { project: string };
    return {
      start: async (brief) => {
        if (closed || signal.aborted) throw ending();
        if (await hasUncommittedChanges(executor.path)) {
          throw new NestedWriterRefusal(
            `${executor.path} has uncommitted changes, which a nested writer would not see: it starts from a commit. Commit the state it should start from, then start it again.`,
          );
        }
        const baseline = await resolveCommit(executor.path, "HEAD");
        if (!baseline) throw new NestedWriterRefusal(`HEAD names no commit in ${executor.path}.`);
        const secrets = configSecrets(this.config());
        const clean = (text: string) => redactContent(text, secrets);
        const stored: NestedWriterBrief = {
          assignment: clean(brief.assignment),
          ...(brief.context ? { context: clean(brief.context) } : {}),
          expectedResult: clean(brief.expectedResult),
        };
        const uuid = randomUUID();
        const id = `writer_${uuid}`;
        const path = join(this.paths.worktrees, id);
        const branch = taskBranch(request.branchType ?? "feature", stored.assignment, uuid);
        // The worktree is bound to the writer before any process can edit.
        this.db
          .prepare(
            `INSERT INTO nested_writers (id, execution_id, brief, path, branch, baseline, status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, 'running', ?)`,
          )
          .run(id, executionId, JSON.stringify(stored), path, branch, baseline, now());
        try {
          await addWorktree(project, path, branch, baseline);
        } catch (error) {
          this.log(
            `worktree for nested writer ${id} could not be created (${(error as NodeJS.ErrnoException).code ?? "git worktree add failed"})`,
          );
          // The branch name derives from Claude's assignment, so the stored error omits it.
          const failure = {
            message:
              "Execution failed with workspace_error: the bridge could not create the nested writer's worktree (see workspace); the nested writer was not started.",
            action:
              "Check that the repository accepts new worktrees and branches (for example with `git worktree add`).",
          };
          this.endNestedWriter(id, "failed", "workspace_error", { error: failure }, true);
          throw new NestedWriterRefusal(
            `Could not create a worktree at ${path} on branch ${branch}; the nested writer was not started.`,
          );
        }
        if (closed || signal.aborted) {
          this.endNestedWriter(id, "cancelled", stopReason, {}, true);
          throw ending();
        }
        const writer = this.nestedWriterRow(id);
        this.record(
          executionId,
          "nested",
          `${id} started on ${branch} from ${baseline}: ${stored.assignment}`,
        );
        const controller = new AbortController();
        const done = this.runNestedWriter(
          writer,
          stored,
          executor,
          request,
          controller.signal,
          () => stopReason,
        )
          .catch((error: unknown) => {
            this.log(`nested writer ${id} failed unexpectedly: ${errorOrigin(error)}`);
            const failure = {
              message:
                "Execution failed with provider_error: the bridge could not run this nested writer.",
              action: "Check service.log in the state directory, then start a new task.",
            };
            this.endNestedWriter(id, "failed", "provider_error", { error: failure }, null);
          })
          .finally(() => {
            runs.delete(id);
            unreported.add(id);
            for (const listener of listeners) listener();
          });
        runs.set(id, { controller, done });
        return nestedWriterReport(writer);
      },
      wait: async (writerIds) => {
        const own = (
          this.db
            .prepare(
              "SELECT id FROM nested_writers WHERE execution_id = ? ORDER BY created_at, rowid",
            )
            .all(executionId) as { id: string }[]
        ).map((row) => row.id);
        const unknown = (writerIds ?? []).filter((id) => !own.includes(id));
        if (unknown.length > 0) {
          throw new NestedWriterRefusal(
            `This task started no nested writer ${unknown.join(", ")}.`,
          );
        }
        const selected = writerIds ?? own;
        await Promise.all(selected.map((id) => runs.get(id)?.done));
        for (const id of selected) unreported.delete(id);
        return selected.map((id) => nestedWriterReport(this.nestedWriterRow(id)));
      },
      running: () => runs.size,
      unreported: () => [...unreported],
      onEnded: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      stopAll: async () => {
        closed = true;
        signal.removeEventListener("abort", cancelled);
        stop();
        await Promise.all([...runs.values()].map((run) => run.done));
      },
    };
  }

  /** Runs a nested writer's Claude Code process in its worktree and records how it ended. */
  private async runNestedWriter(
    writer: NestedWriterRow,
    brief: NestedWriterBrief,
    executor: WorkspaceRow,
    request: StartRequest,
    signal: AbortSignal,
    stopReason: () => string,
  ): Promise<void> {
    const config = this.config();
    const secrets = configSecrets(config);
    const executable = claudeExecutable(config);
    const clean = (text: string) => redactContent(text, secrets);
    const event = (text: string) =>
      this.record(writer.execution_id, "nested", `${writer.id}${text}`);
    const observer: ExecutionObserver = {
      session: (sessionId) => {
        this.db
          .prepare("UPDATE nested_writers SET session_id = ? WHERE id = ?")
          .run(sessionId, writer.id);
      },
      capacity: (waiting) =>
        event(waiting ? " is waiting for subscription capacity." : " continues."),
      message: (text) => event(`: ${clean(text)}`),
      // Strings are redacted before serialization, which would escape them.
      toolCall: (name, input) => event(`: ${name} ${JSON.stringify(redactStrings(input, clean))}`),
      request: (pending, requestSignal) =>
        this.raise(writer.execution_id, pending, requestSignal, secrets, writer.id),
      // Without the Agent tool, Claude Code reports no nested agents of a nested writer.
      nestedStarted: () => {},
      nestedProgress: () => {},
      nestedEnded: () => {},
      waitingForChildren: () => {},
    };
    let outcome: ExecutionOutcome = executable
      ? await runExecution(
          {
            executable,
            env: claudeEnvironment(config),
            extraArgs: mcpConfigArgs(this.paths, config),
            cwd: writer.path,
            prompt: prompt(brief),
            guidance: nestedWriterGuidance(writer, executor),
            disallowedTools: writingDisallowedTools,
            resultSchema: writingResult,
            approvalServers: approvalServers(config),
            ...(request.model ? { model: request.model } : {}),
            ...(request.effort ? { effort: request.effort } : {}),
            signal,
            secrets,
          },
          observer,
        )
      : {
          status: "failed",
          reason: "provider_error",
          message: "Execution failed with provider_error: Claude Code was not found.",
          action: `Install Claude Code, or set "claudeExecutable" in ${this.paths.config}.`,
          processExited: true,
        };
    // The writer's changes stay in its worktree whatever the outcome.
    const changes = await listedChanges(writer.path, writer.baseline, secrets);
    const retained = changes ? { changes } : {};
    // Cancellation wins over a failure it raced, even after Claude Code has returned.
    if (outcome.status === "failed" && signal.aborted) {
      outcome = { status: "cancelled", processExited: outcome.processExited };
    }
    let status: string;
    let reason: string | null = null;
    if (outcome.status === "completed") {
      const parsed = writingResult.safeParse(outcome.structured);
      const reported = parsed.success
        ? parsed.data
        : { summary: outcome.text, evidence: [], failures: [], remainingWork: [], checks: [] };
      const result = {
        summary: clean(reported.summary),
        evidence: reported.evidence.map(clean),
        failures: reported.failures.map(clean),
        remainingWork: reported.remainingWork.map(clean),
        checks: reported.checks.map((check) => redactStrings(check, clean)),
      };
      status = "completed";
      this.endNestedWriter(
        writer.id,
        status,
        reason,
        { result, ...retained },
        outcome.processExited,
      );
    } else if (outcome.status === "failed") {
      status = "failed";
      reason = outcome.reason;
      // Claude chooses file names and commit subjects, so they stay in workspace, out of `error`.
      const error = {
        message: [
          outcome.message,
          ...(changes
            ? [
                `The nested writer's worktree holds ${plural(changes.commitCount, "commit")} and ${plural(changes.changedFileCount, "changed file")} (see workspace).`,
              ]
            : []),
        ].join(" "),
        action: outcome.action,
      };
      this.endNestedWriter(
        writer.id,
        status,
        reason,
        { error, ...retained },
        outcome.processExited,
      );
    } else {
      status = "cancelled";
      reason = stopReason();
      this.endNestedWriter(writer.id, status, reason, retained, outcome.processExited);
    }
    event(` ${status}${reason ? ` (${reason})` : ""}.`);
  }

  /** Records how a running nested writer ended; a writer that already ended keeps its outcome. */
  private endNestedWriter(
    id: string,
    status: string,
    reason: string | null,
    outcome: object,
    processExited: boolean | null,
  ): void {
    this.db
      .prepare(
        `UPDATE nested_writers SET status = ?, reason = ?, outcome = ?, process_exited = ?, ended_at = ?
         WHERE id = ? AND status = 'running'`,
      )
      .run(
        status,
        reason,
        JSON.stringify(outcome),
        processExited === null ? null : processExited ? 1 : 0,
        now(),
        id,
      );
  }

  private nestedWriterRow(id: string): NestedWriterRow {
    return this.db
      .prepare("SELECT * FROM nested_writers WHERE id = ?")
      .get(id) as unknown as NestedWriterRow;
  }

  private nestedWriterRows(executionId: string): NestedWriterRow[] {
    return this.db
      .prepare("SELECT * FROM nested_writers WHERE execution_id = ? ORDER BY created_at, rowid")
      .all(executionId) as unknown as NestedWriterRow[];
  }

  /** The nested writers an execution started, as task_status and cancel_task show them. */
  private nestedWriterReports(executionId: string) {
    const rows = this.nestedWriterRows(executionId);
    return rows.length > 0 ? { nestedWriters: rows.map(nestedWriterReport) } : {};
  }

  /** Where each nested writer's work is, kept with the execution's result. */
  private nestedWriterReferences(executionId: string) {
    const rows = this.nestedWriterRows(executionId);
    if (rows.length === 0) return {};
    return {
      nestedWriters: rows.map((row) => ({
        writerId: row.id,
        status: row.status,
        branch: row.branch,
        baseline: row.baseline,
        path: row.path,
      })),
    };
  }

  /** Starts the task's next queued execution unless one of its executions is running. */
  private schedule(taskId: string): void {
    if (this.launching.has(taskId)) return;
    const running = this.db
      .prepare("SELECT 1 FROM executions WHERE task_id = ? AND status = 'running'")
      .get(taskId);
    if (running) return;
    const next = this.db
      .prepare(
        "SELECT id FROM executions WHERE task_id = ? AND status = 'queued' ORDER BY ordinal LIMIT 1",
      )
      .get(taskId) as { id: string } | undefined;
    if (!next) return;
    this.launching.add(taskId);
    setImmediate(() => {
      this.launching.delete(taskId);
      this.launch(taskId, next.id);
    });
  }

  private launch(taskId: string, executionId: string): void {
    const controller = new AbortController();
    const done = this.execute(executionId, controller.signal)
      .catch((error: unknown) => {
        this.log(`execution ${executionId} failed unexpectedly: ${errorOrigin(error)}`);
        this.update(executionId, {
          status: "failed",
          reason: "provider_error",
          // The error's own text can carry Claude Code's output; only its type is reported.
          error: JSON.stringify({
            message: `Execution failed with provider_error: the bridge service could not run it (${errorOrigin(error)}).`,
            action:
              "Call readiness for the project and fix any problem it reports, then start a new task with a new request key.",
          }),
          ended_at: now(),
        });
      })
      .finally(() => {
        this.running.delete(executionId);
        this.waits.delete(executionId);
        this.schedule(taskId);
      });
    this.running.set(executionId, { controller, done });
  }

  private async execute(executionId: string, signal: AbortSignal): Promise<void> {
    if (!this.update(executionId, { status: "running", started_at: now() }, "queued")) return;
    this.waits.set(executionId, { requests: new Set(), runningNested: 0 });
    this.record(executionId, "status", "Running.");
    const execution = this.db
      .prepare("SELECT * FROM executions WHERE id = ?")
      .get(executionId) as unknown as ExecutionRow;
    const task = this.db
      .prepare("SELECT * FROM tasks WHERE id = ?")
      .get(execution.task_id) as unknown as TaskRow;
    const root = task.project;
    const request = JSON.parse(task.request) as StartRequest;
    const followUp = execution.kind === "follow-up";
    const workspace = this.workspace(task.id);
    const config = this.config();
    const secrets = configSecrets(config);
    const executable = claudeExecutable(config);
    let outcome: ExecutionOutcome;
    let before: Map<string, string> | undefined;
    let writers: NestedWriters | undefined;
    if (!executable) {
      outcome = {
        status: "failed",
        reason: "provider_error",
        message: "Execution failed with provider_error: Claude Code was not found.",
        action: `Install Claude Code, or set "claudeExecutable" in ${this.paths.config}.`,
        processExited: true,
      };
    } else if (followUp && !task.session_id) {
      // Never answer a follow-up in a new, unrelated conversation.
      outcome = {
        status: "failed",
        reason: "session_unavailable",
        message:
          "Execution failed with session_unavailable: the task has no Claude session to continue; the follow-up was not sent.",
        action:
          "Start a new task with the context the follow-up needs; the earlier results stay available.",
        processExited: true,
      };
    } else if (workspace && !(await this.prepareWorkspace(workspace))) {
      outcome = {
        status: "failed",
        reason: "workspace_error",
        message: `Execution failed with workspace_error: could not create the task worktree at ${workspace.path} on branch ${workspace.branch}; no execution was started.`,
        action:
          "Check that the repository accepts new worktrees and branches (for example with `git worktree add`), then start a new task.",
        processExited: true,
      };
    } else {
      if (!workspace) before = await checkoutState(root);
      if (workspace) writers = this.nestedWriters(executionId, request, workspace, signal);
      outcome = await runExecution(
        {
          executable,
          env: claudeEnvironment(config),
          extraArgs: mcpConfigArgs(this.paths, config),
          cwd: workspace?.path ?? root,
          prompt: followUp ? `<follow-up>\n${execution.input}\n</follow-up>` : prompt(request),
          ...(followUp && task.session_id ? { resume: task.session_id } : {}),
          signal,
          guidance: workspace ? writingGuidance(workspace, root) : readOnlyGuidance(root),
          disallowedTools: workspace ? writingDisallowedTools : readOnlyDisallowedTools,
          resultSchema: workspace ? writingResult : reportedResult,
          approvalServers: approvalServers(config),
          ...(request.model ? { model: request.model } : {}),
          ...(request.effort ? { effort: request.effort } : {}),
          secrets,
          ...(writers ? { nestedWriters: writers } : {}),
        },
        {
          session: (sessionId) => {
            this.update(executionId, { session_id: sessionId });
            this.db
              .prepare(
                "UPDATE tasks SET session_id = ? WHERE id = (SELECT task_id FROM executions WHERE id = ?)",
              )
              .run(sessionId, executionId);
          },
          capacity: (waiting) => {
            const waits = this.waits.get(executionId);
            if (!waits || JSON.stringify(waits.capacity) === JSON.stringify(waiting)) return;
            this.block(executionId, (current) => {
              if (waiting) current.capacity = waiting;
              else delete current.capacity;
            });
            this.record(
              executionId,
              "status",
              waiting
                ? `Waiting for subscription capacity${waiting.resetsAt ? ` until ${new Date(waiting.resetsAt * 1000).toISOString()}` : ""}.`
                : "Subscription capacity is available again.",
            );
          },
          message: (text) => this.record(executionId, "assistant", redactContent(text, secrets)),
          // Strings are redacted before serialization, which would escape them.
          toolCall: (name, input, nestedTaskId) =>
            this.record(
              executionId,
              nestedTaskId ? "nested" : "tool",
              `${nestedTaskId ? `${nestedTaskId}: ` : ""}${name} ${JSON.stringify(redactStrings(input, (text) => redactContent(text, secrets)))}`,
            ),
          request: (pending, requestSignal) =>
            this.raise(executionId, pending, requestSignal, secrets),
          nestedStarted: (nested) => {
            const description = redactContent(nested.description, secrets);
            this.db
              .prepare(
                `INSERT OR IGNORE INTO nested_tasks (execution_id, task_id, tool_use_id, parent_tool_use_id,
                   description, agent_type, background, depth, status, started_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)`,
              )
              .run(
                executionId,
                nested.taskId,
                nested.toolUseId ?? null,
                nested.parentToolUseId ?? null,
                description,
                nested.agentType ?? null,
                nested.background ? 1 : 0,
                nested.depth ?? null,
                now(),
              );
            this.record(
              executionId,
              "nested",
              `${nested.taskId} started${nested.background ? " in the background" : ""}: ${description}`,
            );
          },
          nestedProgress: (taskId, summary) =>
            this.record(executionId, "nested", `${taskId}: ${redactContent(summary, secrets)}`),
          nestedEnded: (taskId, end) => {
            const summary = end.summary === undefined ? null : redactContent(end.summary, secrets);
            this.db
              .prepare(
                `UPDATE nested_tasks SET status = ?, summary = ?, termination = ?, ended_at = ?
                 WHERE execution_id = ? AND task_id = ? AND status = 'running'`,
              )
              .run(end.status, summary, end.termination, now(), executionId, taskId);
            this.record(
              executionId,
              "nested",
              `${taskId} ${end.status}${end.termination === "reported" ? "" : ` (${end.termination})`}${summary ? `: ${summary}` : ""}`,
            );
          },
          waitingForChildren: (count) => {
            const waits = this.waits.get(executionId);
            if (!waits) return;
            const previous = waits.runningNested;
            this.block(executionId, (current) => (current.runningNested = count));
            if (previous === 0 && count > 0) {
              this.record(
                executionId,
                "status",
                `Claude finished its turn; waiting for ${count} nested agent(s).`,
              );
            } else if (previous > 0 && count === 0) {
              this.record(executionId, "status", "Nested agents ended; Claude continues.");
            }
          },
        },
      );
    }
    // The execution ends only once the nested writers it started have stopped.
    await writers?.stopAll();
    const endedAt = now();
    // Claude chooses file names; redaction is a backstop for credentials in them.
    const modifiedFiles = (before ? changedPaths(before, await checkoutState(root)) : []).map(
      (path) => redactContent(path, secrets),
    );
    // A writing task's changes stay in its worktree whatever the outcome.
    const changes =
      workspace && this.workspace(task.id)?.state === "ready"
        ? await listedChanges(workspace.path, workspace.baseline, secrets)
        : undefined;
    const retained = workspace
      ? { workspace: { ...workspaceReport(this.workspace(task.id)!), ...changes } }
      : {};
    const violation =
      modifiedFiles.length > 0
        ? [`The read-only task changed the shared checkout: ${modifiedFiles.join(", ")}.`]
        : [];
    // Cancellation wins over a failure it raced, even after Claude Code has returned.
    if (outcome.status === "failed" && signal.aborted) {
      outcome = { status: "cancelled", processExited: outcome.processExited };
    }
    if (outcome.status === "cancelled") {
      const cancelled = this.update(executionId, {
        status: "cancelled",
        reason: "cancelled",
        detail: JSON.stringify({
          processExited: outcome.processExited,
          ...(modifiedFiles.length > 0 ? { modifiedFiles } : {}),
          ...retained,
        }),
        ended_at: endedAt,
      });
      if (cancelled) {
        this.record(
          executionId,
          "status",
          outcome.processExited
            ? "Cancelled; Claude Code has exited."
            : "Cancelled; Claude Code did not exit within the grace period.",
        );
      }
      return;
    }
    if (outcome.status === "failed") {
      const failed = this.update(executionId, {
        status: "failed",
        reason: outcome.reason,
        // Claude chooses file names and commit subjects, so they stay out of `error`.
        detail:
          outcome.detail || !outcome.processExited || modifiedFiles.length > 0 || workspace
            ? JSON.stringify({
                ...outcome.detail,
                ...(outcome.processExited ? {} : { processExited: false }),
                ...(modifiedFiles.length > 0 ? { modifiedFiles } : {}),
                ...retained,
              })
            : null,
        error: JSON.stringify({
          message: [
            outcome.message,
            ...(modifiedFiles.length > 0
              ? [
                  `The read-only task changed ${plural(modifiedFiles.length, "file")} in the shared checkout (see detail.modifiedFiles).`,
                ]
              : []),
            ...(changes
              ? [
                  `The task's worktree holds ${plural(changes.commitCount, "commit")} and ${plural(changes.changedFileCount, "changed file")} (see detail.workspace).`,
                ]
              : []),
          ].join(" "),
          action: outcome.action,
        }),
        ended_at: endedAt,
      });
      if (failed) this.record(executionId, "status", `Failed (${outcome.reason}).`);
      return;
    }
    const parsed = (workspace ? writingResult : reportedResult).safeParse(outcome.structured);
    const reported = parsed.success
      ? parsed.data
      : { summary: outcome.text, evidence: [], failures: [], remainingWork: [] };
    // Claude can read configured credentials; they must not reach Codex through results.
    const clean = (text: string) => redactContent(text, secrets);
    const checks =
      parsed.success && "checks" in parsed.data
        ? (parsed.data as z.infer<typeof writingResult>).checks
        : [];
    const result = {
      summary: clean(reported.summary),
      evidence: reported.evidence.map(clean),
      failures: [...reported.failures.map(clean), ...violation],
      remainingWork: reported.remainingWork.map(clean),
      ...(workspace
        ? {
            checks: checks.map((check) => redactStrings(check, clean)),
            ...retained,
            ...this.nestedWriterReferences(executionId),
          }
        : { workspace: { kind: "shared-checkout", path: root, readOnly: true, modifiedFiles } }),
    };
    const completed = this.update(executionId, {
      status: "completed",
      reason: null,
      detail: outcome.processExited ? null : JSON.stringify({ processExited: false }),
      result: JSON.stringify(result),
      ended_at: endedAt,
    });
    if (completed) this.record(executionId, "result", result.summary);
  }
}

interface ResultPart {
  part: number;
  field: string;
  index?: number;
  /** Which string of a structured item the part holds, such as a check's `command`. */
  key?: string;
  /** Short values that belong with the part: a check's outcome, a commit's SHA. */
  outcome?: string;
  sha?: string;
  text: string;
}

type Check = z.infer<typeof writingResult>["checks"][number];

interface StoredResult {
  summary: string;
  evidence: string[];
  failures: string[];
  remainingWork: string[];
  checks?: Check[];
  workspace?: { commits?: { sha: string; subject: string }[]; changedFiles?: string[] };
}

/**
 * The text of a result as an ordered list of parts: the summary, each list
 * item, each check's command and details, and each commit subject and changed
 * file of a writing task's workspace.
 */
function resultParts(result: StoredResult): ResultPart[] {
  const fields = [
    ["evidence", result.evidence],
    ["failures", result.failures],
    ["remainingWork", result.remainingWork],
  ] as const;
  const parts: Omit<ResultPart, "part">[] = [
    { field: "summary", text: result.summary },
    ...fields.flatMap(([field, items]) => items.map((text, index) => ({ field, index, text }))),
    ...(result.checks ?? []).flatMap((check, index) => [
      { field: "checks", index, key: "command", outcome: check.outcome, text: check.command },
      ...(check.details === undefined
        ? []
        : [{ field: "checks", index, key: "details", text: check.details }]),
    ]),
    ...(result.workspace?.commits ?? []).map(({ sha, subject }, index) => ({
      field: "commits",
      index,
      sha,
      text: subject,
    })),
    ...(result.workspace?.changedFiles ?? []).map((text, index) => ({
      field: "changedFiles",
      index,
      text,
    })),
  ];
  return parts.map((item, part) => ({ part, ...item }));
}

type ShownPart = ResultPart & { offset?: number; complete?: false };

/** Checks as shown in a bounded result; a check whose text was cut says complete: false. */
function shownChecks(page: ShownPart[], stored: Check[]) {
  const shown = new Map<number, { command: string; details?: string; complete?: false }>();
  for (const part of page.filter((item) => item.field === "checks")) {
    const check = shown.get(part.index!) ?? { command: "" };
    if (part.key === "command") check.command = part.text;
    else check.details = part.text;
    if (part.complete === false) check.complete = false;
    shown.set(part.index!, check);
  }
  return [...shown].map(([index, check]) => {
    const original = stored[index]!;
    const missingDetails = original.details !== undefined && check.details === undefined;
    return {
      command: check.command,
      outcome: original.outcome,
      ...(check.details === undefined ? {} : { details: check.details }),
      ...(check.complete === false || missingDetails ? { complete: false } : {}),
    };
  });
}

/** Reads parts from a position, returning at most `budget` characters and where to continue. */
function readParts(parts: ResultPart[], start: number, offset: number, budget: number) {
  const page: ShownPart[] = [];
  let remaining = budget;
  for (let part = start; part < parts.length; part++) {
    const from = part === start ? offset : 0;
    const whole = parts[part]!;
    const text = whole.text.slice(from);
    if (remaining === 0) return { parts: page, next: { part, offset: from } };
    const shown = text.slice(0, remaining);
    page.push({
      ...whole,
      text: shown,
      ...(from > 0 ? { offset: from } : {}),
      ...(shown.length < text.length ? { complete: false as const } : {}),
    });
    remaining -= shown.length;
    if (shown.length < text.length) {
      return { parts: page, next: { part, offset: from + shown.length } };
    }
  }
  return { parts: page };
}

/**
 * The keys the parent answers a question request's questions by, in the order
 * asked: each question's displayed text, with " (question N)" appended while
 * it equals the key of an earlier question.
 */
function questionTexts(payload: unknown): string[] {
  const questions = (payload as { questions?: unknown }).questions;
  if (!Array.isArray(questions)) return [];
  const keys = new Set<string>();
  return questions.map((item: { question?: unknown }, index) => {
    // Redaction can make questions look alike; later ones are told apart by position.
    let key = typeof item.question === "string" ? item.question : `Question ${index + 1}`;
    while (keys.has(key)) key = `${key} (question ${index + 1})`;
    keys.add(key);
    return key;
  });
}

function responseHash(response: object): string {
  return createHash("sha256").update(JSON.stringify(response)).digest("hex");
}

/** Applies `clean` to every string inside a JSON-like value. */
function redactStrings(value: unknown, clean: (text: string) => string): unknown {
  if (typeof value === "string") return clean(value);
  if (Array.isArray(value)) return value.map((item) => redactStrings(item, clean));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactStrings(item, clean)]),
    );
  }
  return value;
}

/** MCP servers whose tool calls wait for the parent agent's approval. */
function approvalServers(config: BridgeConfig): string[] {
  return Object.entries(config.mcpServers)
    .filter(([, server]) => !server.autoApprove)
    .map(([name]) => name);
}

const worktreeIsolation =
  "Git worktree: separate files and branch, not an operating-system sandbox.";

/** A number with its noun, such as "1 file" or "2 files". */
function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function workspaceReport(workspace: WorkspaceRow) {
  return {
    kind: "worktree",
    path: workspace.path,
    branch: workspace.branch,
    baseline: workspace.baseline,
    parentDirty: workspace.parent_dirty === 1,
    state: workspace.state,
    isolation: worktreeIsolation,
  };
}

/** Commits and changed files of a worktree since its baseline, redacted, with long lists cut. */
function listedChanges(path: string, baseline: string, secrets: readonly string[]) {
  return worktreeChanges(path, baseline)
    .then(({ commits, changedFiles }) => ({
      // Long lists are cut; the worktree itself holds every change.
      commits: commits.slice(0, maxListedChanges).map(({ sha, subject }) => ({
        sha,
        subject: redactContent(subject.slice(0, maxSubjectChars), secrets),
      })),
      changedFiles: changedFiles
        .slice(0, maxListedChanges)
        .map((file) => redactContent(file, secrets)),
      commitCount: commits.length,
      changedFileCount: changedFiles.length,
    }))
    .catch(() => undefined);
}

/** A nested writer with its workspace, change set, and result or error, as the executor and the parent see it. */
function nestedWriterReport(row: NestedWriterRow) {
  const brief = JSON.parse(row.brief) as NestedWriterBrief;
  const outcome = (row.outcome ? JSON.parse(row.outcome) : {}) as {
    result?: object;
    error?: object;
    changes?: object;
  };
  return {
    writerId: row.id,
    status: row.status,
    ...(row.reason ? { reason: row.reason } : {}),
    assignment: brief.assignment,
    workspace: {
      kind: "worktree",
      path: row.path,
      branch: row.branch,
      baseline: row.baseline,
      isolation: worktreeIsolation,
      ...outcome.changes,
    },
    ...(outcome.result ? { result: outcome.result } : {}),
    ...(outcome.error ? { error: outcome.error } : {}),
    ...(row.process_exited === 0 ? { processExited: false } : {}),
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    startedAt: row.created_at,
    ...(row.ended_at ? { endedAt: row.ended_at } : {}),
  };
}

function executionState(execution: ExecutionRow) {
  return {
    status: execution.status,
    ...(execution.reason ? { reason: execution.reason } : {}),
    ...(execution.detail ? { detail: JSON.parse(execution.detail) } : {}),
    ...(execution.error ? { error: JSON.parse(execution.error) } : {}),
    terminal: terminalStatuses.includes(execution.status),
  };
}
