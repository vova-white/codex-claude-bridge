import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { reportedResult, runExecution, type ExecutionOutcome } from "../claude/execution.ts";
import { claudeEnvironment, claudeExecutable, mcpConfigArgs } from "../claude/readiness.ts";
import { type BridgeConfig, configSecrets } from "../config.ts";
import { redactContent } from "../redact.ts";
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

const taskLookup = z.object({ project: z.string().min(1), taskId: z.string().min(1) });
const resultLookup = taskLookup.extend({ executionId: z.string().min(1).optional() });
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
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
}

const terminalStatuses = ["completed", "failed", "interrupted"];

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
  }

  /**
   * A new service never inherits live Claude Code processes, so executions the
   * previous service left unfinished cannot be running any more.
   */
  interruptUnfinished(): void {
    const changed = this.db
      .prepare(
        `UPDATE executions SET status = 'interrupted', reason = 'service_restarted', detail = NULL, ended_at = ?
         WHERE status IN ('queued', 'running')`,
      )
      .run(now());
    if (changed.changes > 0) {
      this.log(`marked ${changed.changes} unfinished execution(s) interrupted`);
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
    // Accepted intent is durable before any Claude Code process starts.
    setImmediate(() => {
      this.execute(executionId, project, request).catch((error: unknown) => {
        this.log(`execution ${executionId} failed unexpectedly: ${(error as Error).stack}`);
        this.update(executionId, {
          status: "failed",
          reason: "provider_error",
          error: JSON.stringify({ message: (error as Error).message }),
          ended_at: now(),
        });
      });
    });
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

  async result(caller: string, params: unknown) {
    const { project, taskId, executionId } = parse(resultLookup, params);
    const task = await this.task(caller, project, taskId);
    const execution = executionId
      ? (this.db
          .prepare("SELECT * FROM executions WHERE task_id = ? AND id = ?")
          .get(task.id, executionId) as ExecutionRow | undefined)
      : this.execution(task.id, 1);
    if (!execution) {
      throw new ServiceError("not_found", `Task ${taskId} has no execution ${executionId}.`);
    }
    return {
      taskId: task.id,
      executionId: execution.id,
      ...executionState(execution),
      result: execution.result ? JSON.parse(execution.result) : null,
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
    return (
      this.db
        .prepare(
          `UPDATE executions SET ${columns.map((column) => `${column} = ?`).join(", ")} WHERE id = ? AND status = ?`,
        )
        .run(...Object.values(fields), executionId, when).changes > 0
    );
  }

  private async execute(executionId: string, root: string, request: StartRequest): Promise<void> {
    if (!this.update(executionId, { status: "running", started_at: now() }, "queued")) return;
    const config = this.config();
    const secrets = configSecrets(config);
    const executable = claudeExecutable(config);
    let outcome: ExecutionOutcome;
    let before: Map<string, string> | undefined;
    if (!executable) {
      outcome = {
        status: "failed",
        reason: "provider_error",
        message: "Claude Code was not found.",
        action: `Install Claude Code, or set "claudeExecutable" in ${this.paths.config}.`,
      };
    } else {
      before = await checkoutState(root);
      outcome = await runExecution(
        {
          executable,
          env: claudeEnvironment(config),
          extraArgs: mcpConfigArgs(this.paths, config),
          cwd: root,
          prompt: prompt(request),
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
            this.update(
              executionId,
              waiting
                ? { reason: "waiting_for_capacity", detail: JSON.stringify(waiting) }
                : { reason: null, detail: null },
            );
          },
        },
      );
    }
    const endedAt = now();
    const modifiedFiles = before ? changedPaths(before, await checkoutState(root)) : [];
    const violation =
      modifiedFiles.length > 0
        ? [`The read-only task changed the shared checkout: ${modifiedFiles.join(", ")}.`]
        : [];
    if (outcome.status === "failed") {
      this.update(executionId, {
        status: "failed",
        reason: outcome.reason,
        detail: outcome.detail ? JSON.stringify(outcome.detail) : null,
        error: JSON.stringify({
          message: [outcome.message, ...violation].join(" "),
          ...(outcome.action ? { action: outcome.action } : {}),
          ...(modifiedFiles.length > 0 ? { modifiedFiles } : {}),
        }),
        ended_at: endedAt,
      });
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
    this.update(executionId, {
      status: "completed",
      reason: null,
      detail: null,
      result: JSON.stringify(result),
      ended_at: endedAt,
    });
  }
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
