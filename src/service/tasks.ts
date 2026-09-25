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
  type ExecutionOutcome,
} from "../claude/execution.ts";
import { claudeEnvironment, claudeExecutable, mcpConfigArgs } from "../claude/readiness.ts";
import { type BridgeConfig, configSecrets } from "../config.ts";
import { errorOrigin, redactContent } from "../redact.ts";
import { ServiceError } from "../ipc.ts";
import type { StatePaths } from "../state.ts";
import {
  type Publication,
  type PublicationReport,
  publicationReport,
  publishModes,
  remoteState,
} from "../publication.ts";
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
  publish: z
    .enum(publishModes)
    .optional()
    .describe(
      "Write mode: pull_request authorizes Claude to push the task branch and create or update its pull request, never merging it; none (default) keeps the commits in the worktree.",
    ),
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

interface PublicationRow {
  task_id: string;
  remote: string;
  repository: string | null;
  revision: string | null;
  uncommitted: number;
  pushed_revision: string | null;
  pr_number: number | null;
  pr_url: string | null;
  pr_state: string | null;
  pr_head: string | null;
  problems: string;
  checked_at: string;
}

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

You may start nested agents with the Agent tool for independent research or review subtasks that can run in parallel, but only when the expected gain in quality or elapsed time outweighs the cost of briefing them, the extra usage, and reconciling their findings. Keep small, sequential, or tightly coupled work yourself. Nested agents have the same read-only restrictions. Wait for every nested agent you start, including background ones, and incorporate their findings into your result: you remain accountable for it, and the parent sees the task as waiting while nested agents run.

No one can answer questions while you work. Make reasonable assumptions, state them, and list anything unresolved as remaining work.

Finish with the structured result: summary (the answer or outcome), evidence (what you inspected or ran and what it showed), failures (anything that failed or could not be verified), and remainingWork (what is left for the parent).`;
}

/**
 * What a publishing task's guidance says about the remote: authority to push
 * and open or update the pull request, and, for a follow-up, the pull request
 * the bridge already found, so Claude updates it instead of creating another.
 */
function publishingGuidance(branch: string, known: PublicationReport | undefined): string {
  const authority = `Publication is enabled for this task, and the assignment authorizes it without a further review: once your commits are in place and your checks have run, push ${branch} to its remote (normally \`git push -u origin ${branch}\`) and open a pull request for it with \`gh pr create\`, following the repository's own guidance for pull request titles, descriptions, and templates. Before creating a pull request, check whether one exists for the branch (\`gh pr list --head ${branch} --state all\`); if it does, update that one by pushing further commits, and with \`gh pr edit\` when its title or description needs to change, instead of creating another. Push only ${branch} and do not rewrite commits you have already pushed. Never merge or close the pull request: the parent agent and the user decide on integration. If pushing or creating the pull request fails, keep your commits, report in failures what failed and what you tried, and finish rather than retrying repeatedly. The bridge checks the remote branch and pull request itself after you finish and reports them to the parent.`;
  if (!known) return authority;
  const pr = known.pullRequest;
  const unsure = known.concerns.some((concern) => concern.code.endsWith("_unavailable"));
  const state = pr
    ? `The bridge found pull request #${pr.number} (${pr.url}, state ${pr.state}) for ${branch}. Update it rather than creating another; if it is no longer open, report that instead of opening a new one unless the follow-up asks for it.`
    : unsure
      ? "The bridge could not complete its check of the remote, so check it yourself before creating a pull request."
      : known.pushedRevision
        ? `The bridge found ${branch} on ${known.remote} at ${known.pushedRevision} and no pull request for it.`
        : `The bridge did not find ${branch} on ${known.remote}.`;
  return `${authority}\n\n${state}`;
}

function writingGuidance(
  workspace: WorkspaceRow,
  parent: string,
  publish?: { known: PublicationReport | undefined },
): string {
  return `You are the child agent carrying out a task delegated by Codex, the parent agent. Work autonomously on the assignment in the user message; the parent reviews your result.

This task uses the writing profile in its own Git worktree at ${workspace.path}, on branch ${workspace.branch}, starting from commit ${workspace.baseline}. Work only inside this worktree: other checkouts, including the parent's at ${parent}, belong to other agents. The worktree isolates Git changes; it is not a sandbox.

Make the changes the assignment needs. Install dependencies and run the checks that fit your changes. Commit your work to ${workspace.branch} with Conventional Commits messages, following the repository's own guidance. ${publish ? publishingGuidance(workspace.branch, publish.known) : "Do not push or open pull requests: publication is not enabled for this task."}

Nested agents are not available in this task: do all of the work yourself.

No one can answer questions while you work. Make reasonable assumptions, state them, and list anything unresolved as remaining work.

Finish with the structured result: summary (what you changed and why), evidence (what you inspected or ran and what it showed), failures (anything that failed or could not be verified), remainingWork (what is left for the parent), and checks (each check you ran and whether it passed).`;
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
    this.db
      .prepare(
        "UPDATE nested_tasks SET status = 'unknown', termination = 'unconfirmed', ended_at = ? WHERE status = 'running'",
      )
      .run(now());
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
    } else if (request.baseline || request.branchType || request.publish) {
      // Absent options also keep the request identity of read-only tasks as it was.
      throw new ServiceError(
        "invalid_arguments",
        "baseline, branchType, and publish apply only to writing tasks; read-only tasks inspect the shared checkout as it is.",
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
    const workspace = this.workspace(task.id);
    const publication = this.publication(task.id);
    return {
      taskId: task.id,
      project: task.project,
      mode: task.mode,
      ...executionState(latest),
      ...(task.session_id ? { sessionId: task.session_id } : {}),
      ...(workspace ? { workspace: workspaceReport(workspace) } : {}),
      ...(workspace && publication
        ? { publication: publicationReport(publication, workspace.path) }
        : {}),
      createdAt: task.created_at,
      request: intent,
      executions: executions.map((execution) => ({
        executionId: execution.id,
        ordinal: execution.ordinal,
        ...executionState(execution),
        ...this.nested(execution.id),
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
    // Every terminal state is written after Claude Code's process exited, or
    // records processExited: false when it could not be confirmed.
    const confirmed = executions.every(
      (execution) =>
        terminalStatuses.includes(execution.status) &&
        (JSON.parse(execution.detail ?? "{}") as { processExited?: boolean }).processExited !==
          false,
    );
    const views = executions.map((execution) => ({
      executionId: execution.id,
      ...executionState(execution),
      ...this.nested(execution.id),
    }));
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

  /** The task's publication as last recorded, if the bridge has checked it. */
  private publication(taskId: string): Publication | undefined {
    const row = this.db.prepare("SELECT * FROM publications WHERE task_id = ?").get(taskId) as
      | PublicationRow
      | undefined;
    if (!row) return undefined;
    const workspace = this.workspace(taskId)!;
    return {
      remote: row.remote,
      repository: row.repository,
      branch: workspace.branch,
      revision: row.revision,
      uncommitted: row.uncommitted === 1,
      pushedRevision: row.pushed_revision,
      pullRequest:
        row.pr_number === null
          ? null
          : {
              number: row.pr_number,
              url: row.pr_url!,
              state: row.pr_state as "OPEN" | "CLOSED" | "MERGED",
              headRevision: row.pr_head!,
            },
      problems: JSON.parse(row.problems) as Publication["problems"],
      checkedAt: row.checked_at,
    };
  }

  /**
   * Checks the task branch on its remote and records the result as the task's
   * publication. What a check cannot determine keeps its earlier value, so a
   * pull request once found stays known.
   */
  private async checkPublication(
    workspace: WorkspaceRow,
    secrets: readonly string[],
  ): Promise<PublicationReport> {
    const found = await remoteState(workspace.path, workspace.branch, secrets);
    const earlier = this.publication(workspace.task_id);
    const pushedRevision =
      found.pushedRevision === undefined ? (earlier?.pushedRevision ?? null) : found.pushedRevision;
    const pullRequest =
      found.pullRequest === undefined ? (earlier?.pullRequest ?? null) : found.pullRequest;
    if (found.problems.length > 0) {
      this.log(`publication check for ${workspace.task_id}: ${found.problems.join(", ")}`);
    }
    this.db
      .prepare(
        `INSERT OR REPLACE INTO publications (task_id, remote, repository, revision, uncommitted,
           pushed_revision, pr_number, pr_url, pr_state, pr_head, problems, checked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        workspace.task_id,
        found.remote,
        found.repository ?? earlier?.repository ?? null,
        found.revision ?? null,
        found.uncommitted ? 1 : 0,
        pushedRevision,
        pullRequest?.number ?? null,
        pullRequest?.url ?? null,
        pullRequest?.state ?? null,
        pullRequest?.headRevision ?? null,
        JSON.stringify(found.problems),
        now(),
      );
    return publicationReport(this.publication(workspace.task_id)!, workspace.path);
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
    const workspace = this.workspace(task.id);
    const publishing = workspace !== undefined && request.publish === "pull_request";
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
      // A follow-up may find an earlier execution's push or pull request, even one
      // whose outcome was never reported.
      const known =
        publishing && followUp ? await this.checkPublication(workspace, secrets) : undefined;
      outcome = await runExecution(
        {
          executable,
          env: claudeEnvironment(config),
          extraArgs: mcpConfigArgs(this.paths, config),
          cwd: workspace?.path ?? root,
          prompt: followUp ? `<follow-up>\n${execution.input}\n</follow-up>` : prompt(request),
          ...(followUp && task.session_id ? { resume: task.session_id } : {}),
          signal,
          guidance: workspace
            ? writingGuidance(workspace, root, publishing ? { known } : undefined)
            : readOnlyGuidance(root),
          disallowedTools: workspace ? writingDisallowedTools : readOnlyDisallowedTools,
          resultSchema: workspace ? writingResult : reportedResult,
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
          toolCall: (name, input, nestedTaskId) =>
            this.record(
              executionId,
              nestedTaskId ? "nested" : "tool",
              `${nestedTaskId ? `${nestedTaskId}: ` : ""}${name} ${JSON.stringify(redactStrings(input, (text) => redactContent(text, secrets)))}`,
            ),
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
            const current = this.db
              .prepare("SELECT reason FROM executions WHERE id = ?")
              .get(executionId) as { reason: string | null };
            if (count === 0 && current.reason !== "waiting_for_children") return;
            const changed = this.update(
              executionId,
              count > 0
                ? {
                    reason: "waiting_for_children",
                    detail: JSON.stringify({ runningNested: count }),
                  }
                : { reason: null, detail: null },
            );
            if (changed && current.reason !== "waiting_for_children") {
              this.record(
                executionId,
                "status",
                `Claude finished its turn; waiting for ${count} nested agent(s).`,
              );
            } else if (changed && count === 0) {
              this.record(executionId, "status", "Nested agents ended; Claude continues.");
            }
          },
        },
      );
    }
    const endedAt = now();
    // Claude chooses file names; redaction is a backstop for credentials in them.
    const modifiedFiles = (before ? changedPaths(before, await checkoutState(root)) : []).map(
      (path) => redactContent(path, secrets),
    );
    // A writing task's changes stay in its worktree whatever the outcome.
    const changes =
      workspace && this.workspace(task.id)?.state === "ready"
        ? await worktreeChanges(workspace.path, workspace.baseline)
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
            .catch(() => undefined)
        : undefined;
    // Cancellation is confirmed without waiting for the remote; the next follow-up checks it.
    const publication =
      publishing && changes && outcome.status !== "cancelled"
        ? await this.checkPublication(workspace, secrets)
        : undefined;
    const retained = workspace
      ? {
          workspace: { ...workspaceReport(this.workspace(task.id)!), ...changes },
          ...(publication ? { publication } : {}),
        }
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
    isolation: "Git worktree: separate files and branch, not an operating-system sandbox.",
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
