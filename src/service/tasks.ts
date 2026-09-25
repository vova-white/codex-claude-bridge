import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { reportedResult, runExecution, type ExecutionOutcome } from "../claude/execution.ts";
import { claudeEnvironment, claudeExecutable, mcpConfigArgs } from "../claude/readiness.ts";
import { type BridgeConfig, configSecrets } from "../config.ts";
import { errorOrigin, redactContent } from "../redact.ts";
import { ServiceError } from "../ipc.ts";
import type { StatePaths } from "../state.ts";
import { changedPaths, checkoutState, repositoryRoot } from "../workspace.ts";

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
    .enum(["read-only"])
    .default("read-only")
    .describe("Task profile. Only read-only work on the shared checkout is supported."),
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

/** Tools a read-only task never gets: file editing and, until nested work is supported, subagents. */
const readOnlyDisallowedTools = ["Edit", "Write", "NotebookEdit", "Agent"];

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
const blockedReasons = new Set(["waiting_for_capacity"]);

function parse<T>(schema: z.ZodType<T>, params: unknown): T {
  const parsed = schema.safeParse(params ?? {});
  if (!parsed.success) throw new ServiceError("invalid_arguments", z.prettifyError(parsed.error));
  return parsed.data;
}

const now = () => new Date().toISOString();

function prompt(request: StartRequest): string {
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

Nested agents are not available in this task: do all of the work yourself.

No one can answer questions while you work. Make reasonable assumptions, state them, and list anything unresolved as remaining work.

Finish with the structured result: summary (the answer or outcome), evidence (what you inspected or ran and what it showed), failures (anything that failed or could not be verified), and remainingWork (what is left for the parent).`;
}

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
    if (unfinished.length > 0) {
      this.log(`marked ${unfinished.length} unfinished execution(s) interrupted`);
    }
  }

  async start(caller: string, params: unknown) {
    const request = parse(startSchema, params);
    const project = await this.projectRoot(request.project);
    this.config(); // Fail before accepting work that could not run.
    const { requestKey, project: _path, ...intent } = request;
    const hash = createHash("sha256").update(JSON.stringify(intent)).digest("hex");

    const existing = this.db
      .prepare("SELECT * FROM tasks WHERE project = ? AND caller = ? AND request_key = ?")
      .get(project, caller, requestKey) as TaskRow | undefined;
    if (existing) {
      if (existing.request_hash !== hash) {
        throw new ServiceError(
          "request_key_conflict",
          `Request key "${requestKey}" already started task ${existing.id} with different arguments. Use a new request key for different work.`,
        );
      }
      const execution = this.execution(existing.id, 1);
      return {
        taskId: existing.id,
        executionId: execution.id,
        status: execution.status,
        created: false,
      };
    }

    const taskId = `task_${randomUUID()}`;
    const executionId = `exec_${randomUUID()}`;
    const createdAt = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
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
    return {
      taskId: task.id,
      project: task.project,
      mode: task.mode,
      ...executionState(latest),
      ...(task.session_id ? { sessionId: task.session_id } : {}),
      createdAt: task.created_at,
      request: intent,
      executions: executions.map((execution) => ({
        executionId: execution.id,
        ordinal: execution.ordinal,
        ...executionState(execution),
        ...(execution.started_at ? { startedAt: execution.started_at } : {}),
        ...(execution.ended_at ? { endedAt: execution.ended_at } : {}),
      })),
    };
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
    const stored = JSON.parse(execution.result) as Record<string, unknown> & {
      summary: string;
      evidence: string[];
      failures: string[];
      remainingWork: string[];
    };
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
        ([key]) => !["summary", "evidence", "failures", "remainingWork"].includes(key),
      ),
    );
    const shown = (field: string) =>
      page.parts.filter((item) => item.field === field).map((item) => item.text);
    return {
      ...state,
      result: {
        summary: shown("summary")[0] ?? "",
        evidence: shown("evidence"),
        failures: shown("failures"),
        remainingWork: shown("remainingWork"),
        ...rest,
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
    // Every terminal state is written after Claude Code's process exited, or
    // records processExited: false when it could not be confirmed.
    const confirmed = executions.every(
      (execution) =>
        terminalStatuses.includes(execution.status) &&
        (JSON.parse(execution.detail ?? "{}") as { processExited?: boolean }).processExited !==
          false,
    );
    return {
      taskId: task.id,
      cancellation: active.length === 0 ? "none_active" : confirmed ? "confirmed" : "requested",
      executions: executions.map((execution) => ({
        executionId: execution.id,
        ...executionState(execution),
      })),
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
      const blocked = current.reason !== initialReason && blockedReasons.has(current.reason ?? "");
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
        this.schedule(taskId);
      });
    this.running.set(executionId, { controller, done });
  }

  private async execute(executionId: string, signal: AbortSignal): Promise<void> {
    if (!this.update(executionId, { status: "running", started_at: now() }, "queued")) return;
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
    const config = this.config();
    const secrets = configSecrets(config);
    const executable = claudeExecutable(config);
    let outcome: ExecutionOutcome;
    let before: Map<string, string> | undefined;
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
    } else {
      before = await checkoutState(root);
      outcome = await runExecution(
        {
          executable,
          env: claudeEnvironment(config),
          extraArgs: mcpConfigArgs(this.paths, config),
          cwd: root,
          prompt: followUp ? `<follow-up>\n${execution.input}\n</follow-up>` : prompt(request),
          ...(followUp && task.session_id ? { resume: task.session_id } : {}),
          signal,
          guidance: readOnlyGuidance(root),
          disallowedTools: readOnlyDisallowedTools,
          ...(request.model ? { model: request.model } : {}),
          ...(request.effort ? { effort: request.effort } : {}),
          secrets,
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
            const current = this.db
              .prepare("SELECT reason, detail FROM executions WHERE id = ?")
              .get(executionId) as { reason: string | null; detail: string | null };
            const detail = waiting ? JSON.stringify(waiting) : null;
            const unchanged = waiting
              ? current.reason === "waiting_for_capacity" && current.detail === detail
              : current.reason !== "waiting_for_capacity";
            if (unchanged) return;
            const changed = this.update(
              executionId,
              waiting ? { reason: "waiting_for_capacity", detail } : { reason: null, detail: null },
            );
            if (changed) {
              this.record(
                executionId,
                "status",
                waiting
                  ? `Waiting for subscription capacity${waiting.resetsAt ? ` until ${new Date(waiting.resetsAt * 1000).toISOString()}` : ""}.`
                  : "Running.",
              );
            }
          },
          message: (text) => this.record(executionId, "assistant", redactContent(text, secrets)),
          // Strings are redacted before serialization, which would escape them.
          toolCall: (name, input) =>
            this.record(
              executionId,
              "tool",
              `${name} ${JSON.stringify(redactStrings(input, (text) => redactContent(text, secrets)))}`,
            ),
        },
      );
    }
    const endedAt = now();
    // Claude chooses file names; redaction is a backstop for credentials in them.
    const modifiedFiles = (before ? changedPaths(before, await checkoutState(root)) : []).map(
      (path) => redactContent(path, secrets),
    );
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
        detail:
          outcome.detail || !outcome.processExited || modifiedFiles.length > 0
            ? JSON.stringify({
                ...outcome.detail,
                ...(outcome.processExited ? {} : { processExited: false }),
                ...(modifiedFiles.length > 0 ? { modifiedFiles } : {}),
              })
            : null,
        error: JSON.stringify({
          message:
            modifiedFiles.length > 0
              ? `${outcome.message} The read-only task changed ${modifiedFiles.length} ${modifiedFiles.length === 1 ? "file" : "files"} in the shared checkout (see detail.modifiedFiles).`
              : outcome.message,
          action: outcome.action,
        }),
        ended_at: endedAt,
      });
      if (failed) this.record(executionId, "status", `Failed (${outcome.reason}).`);
      return;
    }
    const parsed = reportedResult.safeParse(outcome.structured);
    const reported = parsed.success
      ? parsed.data
      : { summary: outcome.text, evidence: [], failures: [], remainingWork: [] };
    // Claude can read configured credentials; they must not reach Codex through results.
    const clean = (text: string) => redactContent(text, secrets);
    const result = {
      summary: clean(reported.summary),
      evidence: reported.evidence.map(clean),
      failures: [...reported.failures.map(clean), ...violation],
      remainingWork: reported.remainingWork.map(clean),
      workspace: { kind: "shared-checkout", path: root, readOnly: true, modifiedFiles },
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
  text: string;
}

/** The text of a result as an ordered list of parts: the summary, then each list item. */
function resultParts(result: {
  summary: string;
  evidence: string[];
  failures: string[];
  remainingWork: string[];
}): ResultPart[] {
  const fields = [
    ["evidence", result.evidence],
    ["failures", result.failures],
    ["remainingWork", result.remainingWork],
  ] as const;
  const parts: Omit<ResultPart, "part">[] = [
    { field: "summary", text: result.summary },
    ...fields.flatMap(([field, items]) => items.map((text, index) => ({ field, index, text }))),
  ];
  return parts.map((item, part) => ({ part, ...item }));
}

/** Reads parts from a position, returning at most `budget` characters and where to continue. */
function readParts(parts: ResultPart[], start: number, offset: number, budget: number) {
  const page: (ResultPart & { offset?: number; complete?: false })[] = [];
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

function executionState(execution: ExecutionRow) {
  return {
    status: execution.status,
    ...(execution.reason ? { reason: execution.reason } : {}),
    ...(execution.detail ? { detail: JSON.parse(execution.detail) } : {}),
    ...(execution.error ? { error: JSON.parse(execution.error) } : {}),
    terminal: terminalStatuses.includes(execution.status),
  };
}
