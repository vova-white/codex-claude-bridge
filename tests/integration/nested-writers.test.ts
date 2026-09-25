import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { Scenario, Step } from "../fixtures/fake-claude.ts";
import { BridgeFixture, isAlive, waitFor, type BridgeOptions } from "../support/bridge.ts";

const fixtures: BridgeFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

const identity = ["-c", "user.name=Child", "-c", "user.email=child@example.invalid"];

const commitAll = (message: string): Step[] => [
  { exec: ["git", "add", "-A"] },
  { exec: ["git", ...identity, "commit", "-qm", message] },
];

const merge = (writer: string, mayFail?: true): Step => ({
  exec: ["git", ...identity, "merge", "--no-edit", `{{${writer}.data.workspace.branch}}`],
  ...(mayFail ? { mayFail } : {}),
});

const startWriter = (saveAs: string, assignment: string): Step => ({
  mcpCall: {
    tool: "start_nested_writer",
    arguments: { assignment, expectedResult: "A committed change." },
    saveAs,
  },
});

const waitWriters = (saveAs: string, writerIds?: string[]): Step => ({
  mcpCall: { tool: "wait_nested_writers", arguments: writerIds ? { writerIds } : {}, saveAs },
});

const finished = (summary: string, failures: string[] = []): Step => ({
  result: {
    structured: {
      summary,
      evidence: [],
      failures,
      remainingWork: [],
      checks: [{ command: "npm test", outcome: "passed" }],
    },
  },
});

/** A nested writer that retitles the README and commits. */
const retitle = (title: string, ...before: Step[]): Step[] => [
  ...before,
  { writeFile: { path: "README.md", content: `# ${title}\n` } },
  ...commitAll(`docs: ${title.toLowerCase()} title`),
  finished(`Retitled the README to ${title}.`),
];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** A configured MCP server whose tools need the parent's approval. */
const trackerConfig = { mcpServers: { tracker: { command: "tracker-mcp" } } };

async function setUp(scenario: Scenario, options: Omit<BridgeOptions, "scenario"> = {}) {
  const fixture = new BridgeFixture({ ...options, scenario });
  fixtures.push(fixture);
  const project = fixture.createRepository();
  const client = await fixture.connect();
  const started = await client.call("start_task", {
    project,
    requestKey: "write-1",
    mode: "write",
    assignment: "Coordinate the README work.",
    expectedResult: "One branch with the README changes.",
  });
  expect(started.isError, started.text).toBe(false);
  const taskId = started.data.taskId as string;
  const status = async () => (await client.call("task_status", { project, taskId })).data;
  const wait = async () =>
    (await client.call("wait_task", { project, taskId, timeoutSeconds: 30 })).data;
  /** The result of an MCP tool call the scripted executor saved. */
  const saved = (name: string) =>
    JSON.parse(readFileSync(join(fixture.root, `${name}.json`), "utf8"));
  return { fixture, project, client, taskId, status, wait, saved };
}

describe("nested writers", () => {
  it("run concurrently in their own worktrees from the executor's committed state, and the executor merges one and reports the other's conflict", async () => {
    const { fixture, project, client, taskId, status, wait, saved } = await setUp(
      {
        turns: [
          {
            match: "Alpha writer",
            steps: retitle("Alpha", { signal: "alpha-running" }, { waitFor: "beta-running" }),
          },
          {
            match: "Beta writer",
            steps: retitle("Beta", { signal: "beta-running" }, { waitFor: "alpha-running" }),
          },
          {
            match: "Coordinate",
            steps: [
              { writeFile: { path: "notes.txt", content: "n\n" } },
              startWriter("dirty", "Alpha writer: retitle the README."),
              ...commitAll("chore: add notes"),
              startWriter("alpha", "Alpha writer: retitle the README."),
              { writeFile: { path: "docs.txt", content: "d\n" } },
              ...commitAll("docs: add docs"),
              startWriter("beta", "Beta writer: retitle the README."),
              waitWriters("waited"),
              merge("alpha"),
              merge("beta", true),
              { exec: ["git", "merge", "--abort"] },
              finished("Merged the alpha writer's change.", [
                "The beta writer's branch conflicts with the alpha writer's change in README.md.",
              ]),
            ],
          },
        ],
      },
      // The bridge's own tools run without approval even when configured servers need it.
      { config: trackerConfig },
    );
    expect(await wait()).toMatchObject({ status: "completed" });

    expect((await status()).requests).toEqual([]);
    const dirty = saved("dirty");
    expect(dirty.isError).toBe(true);
    expect(dirty.text).toContain("uncommitted");

    const { workspace: executor } = await status();
    const subjects = new Map(
      git(executor.path, "log", "--format=%s%x09%H")
        .split("\n")
        .map((line) => line.split("\t") as [string, string]),
    );
    const alpha = saved("alpha").data;
    const beta = saved("beta").data;
    expect(alpha.workspace.baseline).toBe(subjects.get("chore: add notes"));
    expect(beta.workspace.baseline).toBe(subjects.get("docs: add docs"));
    for (const writer of [alpha, beta]) {
      expect(writer.workspace.branch).toMatch(/^feature\/.+-[0-9a-f]{8}$/);
      expect(writer.workspace.isolation).toContain("not an operating-system sandbox");
    }
    expect(new Set([executor.branch, alpha.workspace.branch, beta.workspace.branch]).size).toBe(3);

    // Each Claude Code process ran in its own checkout; none in the executor's or the project's.
    const cwds = fixture.launches().map((launch) => launch.cwd);
    // The writers start concurrently, so only the executor's launch has a fixed place.
    expect(cwds[0]).toBe(executor.path);
    expect(cwds.slice(1).toSorted()).toEqual(
      [alpha.workspace.path, beta.workspace.path].toSorted(),
    );
    expect(new Set(cwds).size).toBe(3);
    expect(cwds).not.toContain(project);

    expect(saved("waited").data.writers).toMatchObject([
      { writerId: alpha.writerId, status: "completed" },
      { writerId: beta.writerId, status: "completed" },
    ]);
    const writers = (await status()).executions[0].nestedWriters;
    expect(writers).toMatchObject([
      {
        writerId: alpha.writerId,
        status: "completed",
        assignment: "Alpha writer: retitle the README.",
        workspace: {
          path: alpha.workspace.path,
          branch: alpha.workspace.branch,
          baseline: alpha.workspace.baseline,
          commitCount: 1,
          changedFileCount: 1,
        },
      },
      { writerId: beta.writerId, status: "completed", workspace: { changedFileCount: 1 } },
    ]);
    expect(writers[0].result).toBeUndefined();

    // The executor assembled one branch and reported the other's conflict.
    expect(readFileSync(join(executor.path, "README.md"), "utf8")).toBe("# Alpha\n");
    expect(subjects.has("docs: alpha title")).toBe(true);
    expect(subjects.has("docs: beta title")).toBe(false);
    expect(git(executor.path, "status", "--porcelain")).toBe("");
    const { result } = (await client.call("task_result", { project, taskId })).data;
    expect(result.failures).toEqual([
      "The beta writer's branch conflicts with the alpha writer's change in README.md.",
    ]);
    expect(result.nestedWriters).toMatchObject([
      {
        writerId: alpha.writerId,
        status: "completed",
        branch: alpha.workspace.branch,
        path: alpha.workspace.path,
        result: {
          summary: "Retitled the README to Alpha.",
          checks: [{ command: "npm test", outcome: "passed" }],
        },
        workspace: { commits: [{ subject: "docs: alpha title" }], changedFiles: ["README.md"] },
      },
      {
        writerId: beta.writerId,
        status: "completed",
        branch: beta.workspace.branch,
        workspace: { changedFiles: ["README.md"] },
      },
    ]);
    expect(git(project, "status", "--porcelain")).toBe("");
    expect(readFileSync(join(project, "README.md"), "utf8")).toBe("# Fixture\n");
  });

  it("keep the execution waiting while a nested writer runs after the executor's turn, then let the executor assemble it", async () => {
    const { fixture, project, client, taskId, status, wait } = await setUp({
      turns: [
        { match: "Alpha writer", steps: retitle("Alpha", { waitFor: "go" }) },
        {
          match: "<nested-writers-ended>",
          steps: [waitWriters("waited"), merge("alpha"), finished("Merged the alpha writer.")],
        },
        {
          match: "Coordinate",
          steps: [
            startWriter("alpha", "Alpha writer: retitle the README."),
            finished("Started a nested writer."),
          ],
        },
      ],
    });
    const waiting = await waitFor(async () => {
      const current = await status();
      return current.reason === "waiting_for_children" ? current : undefined;
    });
    expect(waiting).toMatchObject({ status: "running", detail: { runningNested: 1 } });
    expect(waiting.executions[0].nestedWriters).toMatchObject([{ status: "running" }]);
    const timedOut = await client.call("wait_task", { project, taskId, timeoutSeconds: 1 });
    expect(timedOut.data).toMatchObject({ timedOut: true, reason: "waiting_for_children" });
    expect((await client.call("task_result", { project, taskId })).data.result).toBeNull();

    fixture.release("go");
    expect(await wait()).toMatchObject({ status: "completed" });
    const { result } = (await client.call("task_result", { project, taskId })).data;
    expect(result.summary).toBe("Merged the alpha writer.");
    expect(result.workspace.commits.map((commit: { subject: string }) => commit.subject)).toContain(
      "docs: alpha title",
    );
    expect(fixture.prompts().some((prompt) => prompt.includes("<nested-writers-ended>"))).toBe(
      true,
    );
  });

  it("take no execution slot, so an executor holding the only slot still runs its writers", async () => {
    const { fixture, project, client, wait } = await setUp(
      {
        turns: [
          {
            match: "Alpha writer",
            steps: retitle("Alpha", { signal: "running" }, { waitFor: "go" }),
          },
          {
            match: "Coordinate",
            steps: [
              startWriter("alpha", "Alpha writer: retitle the README."),
              waitWriters("waited"),
              merge("alpha"),
              finished("Merged the alpha writer."),
            ],
          },
        ],
      },
      { config: { maxConcurrentExecutions: 1 } },
    );
    await waitFor(() => fixture.signalled("running"));
    expect((await client.call("list_tasks", { project })).data.slots).toEqual({
      limit: 1,
      running: 1,
      queued: 0,
    });
    fixture.release("go");
    expect(await wait()).toMatchObject({ status: "completed" });
  });

  it("let the executor assemble a nested writer that ended before the executor's turn without collecting it", async () => {
    const { fixture, project, client, taskId, status, wait } = await setUp({
      turns: [
        { match: "Alpha writer", steps: retitle("Alpha") },
        {
          match: "<nested-writers-ended>",
          steps: [waitWriters("waited"), merge("alpha"), finished("Merged the alpha writer.")],
        },
        {
          match: "Coordinate",
          steps: [
            startWriter("alpha", "Alpha writer: retitle the README."),
            { waitFor: "alpha-ended" },
            finished("Started a nested writer."),
          ],
        },
      ],
    });
    await waitFor(async () =>
      (await status()).executions[0]?.nestedWriters?.[0]?.status === "completed" ? true : undefined,
    );
    fixture.release("alpha-ended");

    expect(await wait()).toMatchObject({ status: "completed" });
    const { result } = (await client.call("task_result", { project, taskId })).data;
    expect(result.summary).toBe("Merged the alpha writer.");
    expect(readFileSync(join(result.workspace.path, "README.md"), "utf8")).toBe("# Alpha\n");
    expect(fixture.prompts().some((prompt) => prompt.includes("<nested-writers-ended>"))).toBe(
      true,
    );
  });

  it("give a follow-up its own nested writers, starting from the branch the earlier execution assembled", async () => {
    const { project, client, taskId, status, wait, saved } = await setUp({
      turns: [
        { match: "Alpha writer", steps: retitle("Alpha") },
        { match: "Beta writer", steps: retitle("Beta") },
        {
          match: "Now retitle it Beta",
          steps: [
            startWriter("beta", "Beta writer: retitle the README."),
            waitWriters("waited-later"),
            merge("beta"),
            finished("Merged the beta writer."),
          ],
        },
        {
          match: "Coordinate",
          steps: [
            startWriter("alpha", "Alpha writer: retitle the README."),
            waitWriters("waited"),
            merge("alpha"),
            finished("Merged the alpha writer."),
          ],
        },
      ],
    });
    expect(await wait()).toMatchObject({ status: "completed" });
    const sent = await client.call("send_followup", {
      project,
      taskId,
      requestKey: "more-1",
      message: "Now retitle it Beta.",
    });
    expect(sent.isError, sent.text).toBe(false);
    const done = await client.call("wait_task", {
      project,
      taskId,
      executionId: sent.data.executionId,
      timeoutSeconds: 30,
    });
    expect(done.data).toMatchObject({ status: "completed" });

    const alpha = saved("alpha").data;
    const beta = saved("beta").data;
    expect(saved("waited-later").data.writers).toMatchObject([{ writerId: beta.writerId }]);
    const { executions, workspace } = await status();
    expect(
      executions.map((execution: { nestedWriters: { writerId: string }[] }) =>
        execution.nestedWriters.map((writer) => writer.writerId),
      ),
    ).toEqual([[alpha.writerId], [beta.writerId]]);
    expect(git(beta.workspace.path, "log", "--format=%s")).toContain("docs: alpha title");
    expect(readFileSync(join(workspace.path, "README.md"), "utf8")).toBe("# Beta\n");
  });

  it("refuse a configured MCP server that takes the name of the bridge's own tools", async () => {
    const fixture = new BridgeFixture({
      config: { mcpServers: { codex_claude_bridge: { command: "impostor-mcp" } } },
    });
    fixtures.push(fixture);
    const project = fixture.createRepository();
    const client = await fixture.connect();
    const refused = await client.call("start_task", {
      project,
      requestKey: "write-1",
      mode: "write",
      assignment: "Coordinate the README work.",
      expectedResult: "One branch.",
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("reserved for the bridge's own tools");
    expect(fixture.launches()).toEqual([]);
  });

  it("surface a nested writer's question as a request of the executor's execution", async () => {
    const question = {
      questions: [
        {
          question: "Which title should the README get?",
          header: "Title",
          multiSelect: false,
          options: [
            { label: "Alpha", description: "The first title" },
            { label: "Beta", description: "The second title" },
          ],
        },
      ],
    };
    const { project, client, taskId, status, wait, saved } = await setUp(
      {
        turns: [
          {
            match: "Alpha writer",
            steps: retitle("Alpha", { canUseTool: { name: "AskUserQuestion", input: question } }),
          },
          {
            match: "Coordinate",
            steps: [
              startWriter("alpha", "Alpha writer: retitle the README."),
              waitWriters("waited"),
              merge("alpha"),
              finished("Merged the alpha writer."),
            ],
          },
        ],
      },
      { config: trackerConfig },
    );
    const asking = await waitFor(async () => {
      const current = await status();
      return current.reason === "needs_input" ? current : undefined;
    });
    const [request] = asking.requests;
    expect(asking.detail).toEqual({ requestId: request.requestId });
    expect(request).toMatchObject({
      executionId: asking.executions[0].executionId,
      writerId: saved("alpha").data.writerId,
      kind: "question",
      live: true,
    });
    expect(request.sessionId).toBe(asking.executions[0].nestedWriters[0].sessionId);

    const answered = await client.call("respond_to_request", {
      project,
      taskId,
      requestId: request.requestId,
      response: { answers: { "Which title should the README get?": "Alpha" } },
    });
    expect(answered.isError, answered.text).toBe(false);
    expect(await wait()).toMatchObject({ status: "completed" });
    expect((await status()).executions[0].nestedWriters[0].status).toBe("completed");
  });

  it("stop running nested writers when the task is cancelled and keep their worktrees", async () => {
    const { fixture, project, client, taskId, saved } = await setUp({
      turns: [
        {
          match: "Alpha writer",
          steps: [
            { writeFile: { path: "partial.txt", content: "p\n" } },
            { signal: "alpha-editing" },
            { waitFor: "never" },
          ],
        },
        {
          match: "Coordinate",
          steps: [startWriter("alpha", "Alpha writer: retitle the README."), waitWriters("w")],
        },
      ],
    });
    await waitFor(() => fixture.signalled("alpha-editing") || undefined);
    const { path } = saved("alpha").data.workspace;
    const writerPid = fixture.launches().find((launch) => launch.cwd === path)!.pid;

    const cancelled = (await client.call("cancel_task", { project, taskId })).data;
    expect(cancelled).toMatchObject({
      cancellation: "confirmed",
      executions: [
        {
          status: "cancelled",
          nestedWriters: [
            {
              status: "cancelled",
              reason: "cancelled",
              workspace: { changedFileCount: 1 },
            },
          ],
        },
      ],
    });
    expect(cancelled.executions[0].nestedWriters[0].processExited).toBeUndefined();
    const { nestedWriters } = (await client.call("task_result", { project, taskId })).data;
    expect(nestedWriters).toMatchObject([
      { status: "cancelled", workspace: { changedFiles: ["partial.txt"] } },
    ]);
    expect(isAlive(writerPid)).toBe(false);
    expect(existsSync(join(path, "partial.txt"))).toBe(true);
    expect(git(project, "worktree", "list")).toContain(path);
  }, 30_000);

  it("keep nested results and workspaces when a writer or the executor fails, and stop writers still running", async () => {
    const { fixture, project, client, taskId, status, wait, saved } = await setUp({
      turns: [
        { match: "Alpha writer", steps: retitle("Alpha") },
        {
          match: "Beta writer",
          steps: [
            { writeFile: { path: "partial.txt", content: "p\n" } },
            { assistant: "Writing partial.txt" },
            { exit: { code: 1, stderr: "claude-stderr-marker" } },
          ],
        },
        {
          match: "Gamma writer",
          steps: [{ signal: "gamma-running" }, { waitFor: "never" }],
        },
        {
          match: "Coordinate",
          steps: [
            startWriter("alpha", "Alpha writer: retitle the README."),
            startWriter("beta", "Beta writer: add a partial file."),
            startWriter("gamma", "Gamma writer: never finish."),
            waitWriters("waited", ["{{alpha.data.writerId}}", "{{beta.data.writerId}}"]),
            { waitFor: "gamma-running" },
            { exit: { code: 1 } },
          ],
        },
      ],
    });
    expect(await wait()).toMatchObject({ status: "failed", reason: "provider_error" });
    expect(saved("waited").data.writers).toMatchObject([
      { status: "completed" },
      { status: "failed", reason: "provider_error" },
    ]);

    const writers = (await status()).executions[0].nestedWriters;
    expect(writers).toMatchObject([
      { status: "completed", workspace: { commitCount: 1 } },
      { status: "failed", reason: "provider_error", workspace: { changedFileCount: 1 } },
      { status: "cancelled", reason: "parent_ended" },
    ]);
    const reported = (await client.call("task_result", { project, taskId })).data;
    expect(reported).toMatchObject({
      result: null,
      nestedWriters: [
        { status: "completed", workspace: { commits: [{ subject: "docs: alpha title" }] } },
        { status: "failed", workspace: { changedFiles: ["partial.txt"] } },
        { status: "cancelled", reason: "parent_ended" },
      ],
    });
    expect(existsSync(join(writers[1].workspace.path, "partial.txt"))).toBe(true);
    // A failed writer's error is composed from known fields; its files are only in workspace.
    expect(writers[1].error.message).toMatch(/^Execution failed with provider_error: /);
    expect(writers[1].error.message).toContain("0 commits and 1 changed file (see workspace)");
    expect(writers[1].error.action).toContain(writers[1].workspace.path);
    expect(JSON.stringify(writers[1].error)).not.toMatch(/partial\.txt|claude-stderr-marker/);
    const gammaPid = fixture.launches().find((launch) => launch.cwd === writers[2].workspace.path)!;
    expect(isAlive(gammaPid.pid)).toBe(false);
    expect(git(project, "branch", "--list", writers[0].workspace.branch)).not.toBe("");
  }, 30_000);

  it("are cleaned up with their task: branches merged into the task branch go once the task branch is integrated", async () => {
    const { project, client, taskId, status, wait, saved } = await setUp({
      turns: [
        { match: "Alpha writer", steps: retitle("Alpha") },
        {
          match: "Coordinate",
          steps: [
            startWriter("alpha", "Alpha writer: retitle the README."),
            waitWriters("waited"),
            merge("alpha"),
            finished("Merged the alpha writer."),
          ],
        },
      ],
    });
    expect(await wait()).toMatchObject({ status: "completed" });
    const { path, branch } = saved("alpha").data.workspace;
    const writerId = saved("alpha").data.writerId;
    const { workspace } = await status();
    const cleanup = async (options: Record<string, unknown> = {}) =>
      (await client.call("cleanup_task", { project, taskId, ...options })).data;
    // The fast-forward merge leaves the task branch and the writer's branch at one commit.
    expect(git(project, "rev-parse", workspace.branch)).toBe(git(project, "rev-parse", branch));

    // With scope all both branches go, so neither keeps the other's commits.
    expect(await cleanup({ dryRun: true })).toMatchObject({
      outcome: "refused",
      branch: { action: "keep", unintegratedCommits: 1 },
      nestedWriters: [
        {
          writerId,
          worktree: { path, action: "keep", uncommittedChanges: false },
          branch: { name: branch, action: "keep", unintegratedCommits: 1 },
        },
      ],
      refusals: [{ code: "unintegrated_commits" }, { code: "unintegrated_commits" }],
    });

    // The kept task branch holds the writer's commits.
    expect(await cleanup({ scope: "worktree" })).toMatchObject({
      outcome: "cleaned",
      worktree: { action: "removed" },
      branch: { action: "keep" },
      nestedWriters: [
        { worktree: { action: "removed" }, branch: { action: "keep", unintegratedCommits: 0 } },
      ],
    });
    expect(existsSync(path)).toBe(false);
    expect(git(project, "branch", "--list", branch)).not.toBe("");
    expect((await status()).executions[0].nestedWriters[0].workspace.state).toBe("branch_kept");

    git(project, "merge", "--quiet", "--ff-only", workspace.branch);
    expect(await cleanup()).toMatchObject({
      outcome: "cleaned",
      worktree: { action: "already_removed" },
      branch: { action: "removed", unintegratedCommits: 0 },
      nestedWriters: [
        {
          worktree: { action: "already_removed" },
          branch: { action: "removed", unintegratedCommits: 0 },
        },
      ],
    });
    expect(git(project, "branch", "--list", branch)).toBe("");
    const after = await status();
    expect(after.workspace.state).toBe("removed");
    expect(after.executions[0].nestedWriters[0].workspace.state).toBe("removed");

    expect(await cleanup()).toMatchObject({
      outcome: "cleaned",
      nestedWriters: [
        { worktree: { action: "already_removed" }, branch: { action: "already_removed" } },
      ],
    });
  });

  it("refuse to delete a nested writer's branch that holds work the executor did not assemble", async () => {
    const { project, client, taskId, status, wait, saved } = await setUp({
      turns: [
        { match: "Alpha writer", steps: retitle("Alpha") },
        {
          match: "Coordinate",
          steps: [
            startWriter("alpha", "Alpha writer: retitle the README."),
            waitWriters("waited"),
            finished("Left the alpha writer's branch unmerged."),
          ],
        },
      ],
    });
    expect(await wait()).toMatchObject({ status: "completed" });
    const { path, branch } = saved("alpha").data.workspace;
    const { workspace } = await status();
    const cleanup = async (options: Record<string, unknown> = {}) =>
      (await client.call("cleanup_task", { project, taskId, ...options })).data;

    const refused = await cleanup();
    expect(refused).toMatchObject({
      outcome: "refused",
      worktree: { action: "keep" },
      nestedWriters: [
        { worktree: { action: "keep" }, branch: { action: "keep", unintegratedCommits: 1 } },
      ],
      refusals: [{ code: "unintegrated_commits" }],
    });
    expect(refused.refusals[0].message).toContain(saved("alpha").data.writerId);
    expect(existsSync(path)).toBe(true);
    expect(existsSync(workspace.path)).toBe(true);

    // Scope worktree keeps the branch, so its commits stay reachable.
    expect(await cleanup({ scope: "worktree" })).toMatchObject({
      outcome: "cleaned",
      nestedWriters: [
        { worktree: { action: "removed" }, branch: { action: "keep", unintegratedCommits: 1 } },
      ],
    });
    expect(existsSync(path)).toBe(false);
    expect(git(project, "log", "--format=%s", "-1", branch)).toBe("docs: alpha title");

    expect(await cleanup({ discardUnintegrated: true })).toMatchObject({
      outcome: "cleaned",
      nestedWriters: [{ worktree: { action: "already_removed" }, branch: { action: "removed" } }],
    });
    expect(git(project, "branch", "--list", branch)).toBe("");
    expect((await status()).executions[0].nestedWriters[0].workspace.state).toBe("removed");
  });

  it("refuse to drop a nested writer's detached HEAD commit when its worktree directory is missing", async () => {
    const { project, client, taskId, wait, saved } = await setUp({
      turns: [
        {
          match: "Alpha writer",
          steps: retitle("Alpha", { exec: ["git", "checkout", "--quiet", "--detach"] }),
        },
        {
          match: "Coordinate",
          steps: [
            startWriter("alpha", "Alpha writer: retitle the README."),
            waitWriters("waited"),
            finished("Left the alpha writer alone."),
          ],
        },
      ],
    });
    expect(await wait()).toMatchObject({ status: "completed" });
    const { path } = saved("alpha").data.workspace;
    const detached = git(path, "rev-parse", "HEAD");
    renameSync(path, `${path}-moved`);

    const refused = (await client.call("cleanup_task", { project, taskId, scope: "worktree" }))
      .data;
    expect(refused).toMatchObject({
      outcome: "refused",
      nestedWriters: [{ worktree: { action: "keep", unintegratedCommits: 1 } }],
      refusals: [{ code: "unintegrated_commits" }],
    });
    expect(refused.refusals[0].message).toContain(`detached HEAD ${detached}`);
  });

  it("refuse cleanup while a nested writer runs, and keep a cancelled writer's changes until the caller discards them", async () => {
    const { fixture, project, client, taskId, status, saved } = await setUp({
      turns: [
        {
          match: "Alpha writer",
          steps: [
            { writeFile: { path: "partial.txt", content: "p\n" } },
            { signal: "alpha-editing" },
            { waitFor: "never" },
          ],
        },
        {
          match: "Coordinate",
          steps: [startWriter("alpha", "Alpha writer: retitle the README."), waitWriters("w")],
        },
      ],
    });
    await waitFor(() => fixture.signalled("alpha-editing") || undefined);
    const { path } = saved("alpha").data.workspace;
    const cleanup = async (options: Record<string, unknown> = {}) =>
      (await client.call("cleanup_task", { project, taskId, ...options })).data;

    expect(await cleanup({ discardUnintegrated: true })).toMatchObject({
      outcome: "refused",
      nestedWriters: [{ worktree: { action: "keep" } }],
      refusals: [{ code: "active_execution" }],
    });
    expect(existsSync(join(path, "partial.txt"))).toBe(true);

    await client.call("cancel_task", { project, taskId });
    const dirty = await cleanup();
    expect(dirty).toMatchObject({
      outcome: "refused",
      nestedWriters: [
        { worktree: { action: "keep", uncommittedChanges: true }, branch: { action: "keep" } },
      ],
      refusals: [{ code: "uncommitted_changes" }],
    });
    expect(dirty.refusals[0].message).toContain(path);
    expect(existsSync(join(path, "partial.txt"))).toBe(true);

    expect(await cleanup({ discardUnintegrated: true })).toMatchObject({
      outcome: "cleaned",
      nestedWriters: [{ worktree: { action: "removed" }, branch: { action: "removed" } }],
    });
    expect(existsSync(path)).toBe(false);
    expect((await status()).executions[0].nestedWriters[0]).toMatchObject({
      status: "cancelled",
      workspace: { state: "removed" },
    });
  }, 30_000);

  it.each(["completed", "failed"])(
    "keep the state small and page every nested writer's commits when the execution %s",
    async (ending) => {
      const names = ["Alpha", "Beta", "Gamma"];
      // Subjects near the 1,000-character limit, so listing a few would exceed small pages.
      const padding = "s".repeat(900);
      const subject = (name: string, index: number) => `feat: ${name} ${index} ${padding}`;
      const { project, client, taskId, wait } = await setUp({
        turns: [
          ...names.map((name) => ({
            match: `${name} writer`,
            steps: [
              {
                exec: [
                  "sh",
                  "-c",
                  `for i in 0 1 2 3 4 5; do
                     git ${identity.join(" ")} commit -q --allow-empty -m "feat: ${name} $i ${padding}"
                   done`,
                ],
              },
              finished(`${name} committed.`),
            ],
          })),
          {
            match: "Coordinate",
            steps: [
              ...names.map((name) => startWriter(name, `${name} writer: commit a lot.`)),
              waitWriters("waited"),
              ending === "completed"
                ? finished("Kept the writers' branches.")
                : { exit: { code: 1 } },
            ],
          },
        ],
      });
      expect(await wait()).toMatchObject({ status: ending });

      const status = await client.call("task_status", { project, taskId });
      // Listing the subjects alone would take over 16,000 characters.
      expect(status.text.length).toBeLessThan(6_000);
      const writers = status.data.executions[0].nestedWriters;
      expect(writers).toHaveLength(3);
      for (const writer of writers) {
        expect(writer).toMatchObject({ status: "completed", workspace: { commitCount: 6 } });
        expect(writer.workspace.branch).toBeTruthy();
        expect(writer.workspace.path).toBeTruthy();
      }

      // Every writer's commits come back through bounded pages.
      const commits = new Map<string, string[]>();
      const add = (writerId: string, text: string, offset?: number) => {
        const list = commits.get(writerId) ?? [];
        if (offset) list[list.length - 1] += text;
        else list.push(text);
        commits.set(writerId, list);
      };
      const first = await client.call("task_result", { project, taskId, maxChars: 200 });
      expect(first.text.length).toBeLessThan(2_500);
      const shown = ending === "completed" ? first.data.result : first.data;
      for (const writer of shown.nestedWriters ?? []) {
        for (const commit of writer.workspace?.commits ?? []) add(writer.writerId, commit.subject);
      }
      let next = first.data.truncated?.next;
      while (next) {
        const page = (await client.call("task_result", { project, taskId, maxChars: 200, ...next }))
          .data;
        expect(JSON.stringify(page).length).toBeLessThan(2_500);
        for (const part of page.parts) {
          if (part.writerId && part.field === "commits") add(part.writerId, part.text, part.offset);
        }
        next = page.truncated?.next;
      }
      for (const [index, writer] of writers.entries()) {
        expect(commits.get(writer.writerId)?.toSorted()).toEqual(
          [0, 1, 2, 3, 4, 5].map((i) => subject(names[index]!, i)),
        );
      }
    },
    30_000,
  );

  it("report nested writers of an interrupted execution as interrupted", async () => {
    const { fixture, project, taskId } = await setUp({
      turns: [
        { match: "Alpha writer", steps: [{ signal: "alpha-running" }, { waitFor: "never" }] },
        {
          match: "Coordinate",
          steps: [startWriter("alpha", "Alpha writer: retitle the README."), waitWriters("w")],
        },
      ],
    });
    await waitFor(() => fixture.signalled("alpha-running") || undefined);
    const pid = fixture.servicePid()!;
    process.kill(pid, "SIGKILL");
    await waitFor(() => !isAlive(pid) || undefined);

    const reconnected = await fixture.connect();
    const recovered = (await reconnected.call("task_status", { project, taskId })).data;
    expect(recovered.executions[0]).toMatchObject({
      status: "interrupted",
      nestedWriters: [
        { status: "interrupted", reason: "service_restarted", recovery: { process: "ended" } },
      ],
    });
  });
});
