import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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
          commits: [{ subject: "docs: alpha title" }],
          changedFiles: ["README.md"],
        },
        result: {
          summary: "Retitled the README to Alpha.",
          checks: [{ command: "npm test", outcome: "passed" }],
        },
      },
      { writerId: beta.writerId, status: "completed", workspace: { changedFiles: ["README.md"] } },
    ]);

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
      { writerId: alpha.writerId, status: "completed", branch: alpha.workspace.branch },
      { writerId: beta.writerId, status: "completed", branch: beta.workspace.branch },
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
              workspace: { changedFiles: ["partial.txt"] },
            },
          ],
        },
      ],
    });
    expect(cancelled.executions[0].nestedWriters[0].processExited).toBeUndefined();
    expect(isAlive(writerPid)).toBe(false);
    expect(existsSync(join(path, "partial.txt"))).toBe(true);
    expect(git(project, "worktree", "list")).toContain(path);
  }, 30_000);

  it("keep nested results and workspaces when a writer or the executor fails, and stop writers still running", async () => {
    const { fixture, project, status, wait, saved } = await setUp({
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
      { status: "completed", workspace: { commits: [{ subject: "docs: alpha title" }] } },
      { status: "failed", reason: "provider_error", workspace: { changedFiles: ["partial.txt"] } },
      { status: "cancelled", reason: "parent_ended" },
    ]);
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
      nestedWriters: [{ status: "interrupted", reason: "service_restarted" }],
    });
  });
});
