import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { Scenario, Step } from "../fixtures/fake-claude.ts";
import { BridgeFixture, isAlive, waitFor, type BridgeClient } from "../support/bridge.ts";

// One parent-agent session end to end, as the delegation skill instructs it,
// across the features the other integration tests cover one at a time.

const fakeGh = resolve("tests/fixtures/fake-gh.ts");
const fixtures: BridgeFixture[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

const commit = (path: string, content: string, message: string): Step[] => [
  { writeFile: { path, content } },
  { exec: ["git", "add", path] },
  {
    exec: [
      "git",
      "-c",
      "user.name=Child",
      "-c",
      "user.email=child@example.invalid",
      "commit",
      "-qm",
      message,
    ],
  },
];

const finished = (summary: string): Step => ({
  result: {
    structured: {
      summary,
      evidence: [],
      failures: [],
      remainingWork: [],
      checks: [{ command: "npm test", outcome: "passed" }],
    },
  },
});

/**
 * A bridge limited to one execution at a time, with a configured MCP server
 * whose tools need the parent's approval, a project whose `origin` is a local
 * bare repository, and the fake GitHub CLI first on the service's PATH.
 */
function setUp(scenario: Scenario) {
  const bin = mkdtempSync(join(tmpdir(), "bridge-gh-"));
  directories.push(bin);
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/sh\nFAKE_GH_DIR='${bin}' exec '${process.execPath}' '${fakeGh}' "$@"\n`,
    { mode: 0o755 },
  );
  const fixture = new BridgeFixture({
    scenario,
    config: { maxConcurrentExecutions: 1, mcpServers: { tracker: { command: "tracker-mcp" } } },
    env: { PATH: `${bin}:${process.env.PATH ?? ""}` },
  });
  fixtures.push(fixture);
  const project = fixture.createRepository();
  const origin = join(fixture.root, "origin.git");
  git(fixture.root, "init", "--quiet", "--bare", origin);
  git(project, "remote", "add", "origin", origin);
  git(project, "push", "--quiet", "origin", "main");
  const pullRequestCreations = () => {
    const log = join(bin, "gh-calls.jsonl");
    if (!existsSync(log)) return 0;
    return readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line).args as string[])
      .filter(([group, action]) => group === "pr" && action === "create").length;
  };
  return { fixture, project, origin, pullRequestCreations };
}

async function call(client: BridgeClient, tool: string, args: Record<string, unknown>) {
  const result = await client.call(tool, args);
  expect(result.isError, result.text).toBe(false);
  return result.data;
}

async function eventTexts(client: BridgeClient, project: string, taskId: string) {
  const output = await call(client, "read_output", { project, taskId, limit: 200 });
  return output.events.map((event: { text: string }) => event.text) as string[];
}

const pullRequestUrl = "https://github.example/owner/repo/pull/1";

describe("acceptance", () => {
  it("carries parallel writing tasks through a request, a reconnect, a follow-up, a service crash, and cleanup", async () => {
    const { fixture, project, origin, pullRequestCreations } = setUp({
      turns: [
        {
          match: "Nested writer",
          steps: [
            { signal: "writer-running" },
            { waitFor: "writer-go" },
            ...commit("NOTES.md", "notes\n", "docs: add notes"),
            finished("Added the notes."),
          ],
        },
        {
          match: "Address the review",
          steps: [
            ...commit("README.md", "# Reviewed fixture\n", "docs: address the review"),
            { exec: ["git", "push", "--quiet", "origin", "HEAD"] },
            { signal: "review-pushed" },
            { waitFor: "never" },
          ],
        },
        {
          match: "Split the notes",
          steps: [
            {
              mcpCall: {
                tool: "start_nested_writer",
                arguments: {
                  assignment: "Nested writer: add notes.",
                  expectedResult: "A committed change.",
                },
                saveAs: "writer",
              },
            },
            { mcpCall: { tool: "wait_nested_writers", arguments: {} } },
            { exec: ["git", "merge", "--quiet", "--ff-only", "{{writer.data.workspace.branch}}"] },
            finished("Assembled the nested writer's notes."),
          ],
        },
        {
          match: "Improve the README",
          steps: [
            {
              canUseTool: {
                name: "mcp__tracker__create_issue",
                input: { title: "Track the README rewrite" },
                mcpServer: { name: "tracker", source: "dynamic" },
              },
            },
            ...commit("README.md", "# Better fixture\n", "docs: improve the README"),
            { exec: ["git", "push", "--quiet", "-u", "origin", "HEAD"] },
            { exec: ["gh", "pr", "create", "--title", "docs: improve the README", "--body", "."] },
            finished("Opened the pull request."),
          ],
        },
      ],
    });

    // Readiness first; the model comes from what Claude Code offers.
    const [first, second] = await Promise.all([fixture.connect(), fixture.connect()]);
    const readiness = await call(first, "readiness", { project });
    expect(readiness).toMatchObject({ ready: true, git: { project: { root: project } } });
    const model = readiness.models.find((entry: { value: string }) => entry.value === "sonnet");
    expect(model).toBeDefined();

    // The publishing task takes the only slot and stops at a permission request.
    const publishing = await call(first, "start_task", {
      project,
      requestKey: "readme-pr",
      mode: "write",
      publish: "pull_request",
      model: model.value,
      assignment: "Improve the README wording.",
      expectedResult: "A pull request with the README change.",
    });
    const blocked = await call(first, "wait_task", {
      project,
      taskId: publishing.taskId,
      executionId: publishing.executionId,
      timeoutSeconds: 30,
    });
    expect(blocked).toMatchObject({ status: "running", reason: "needs_input" });
    expect(fixture.launches().at(-1)!.args.join(" ")).toContain(`--model ${model.value}`);

    // A second client's writing task waits for the slot the blocked task still holds.
    const splitting = await call(second, "start_task", {
      project,
      requestKey: "notes",
      mode: "write",
      assignment: "Split the notes work among nested writers.",
      expectedResult: "One branch with the notes.",
    });
    expect(splitting).toMatchObject({
      created: true,
      status: "queued",
      reason: "waiting_for_slot",
      detail: { position: 1, limit: 1 },
    });
    expect((await call(second, "list_tasks", { project })).slots).toEqual({
      limit: 1,
      running: 1,
      queued: 1,
    });

    const { requests } = await call(first, "task_status", { project, taskId: publishing.taskId });
    expect(requests).toMatchObject([
      { requestId: blocked.detail.requestId, kind: "permission", live: true },
    ]);
    await call(first, "respond_to_request", {
      project,
      taskId: publishing.taskId,
      requestId: blocked.detail.requestId,
      response: { decision: "allow" },
    });
    expect(
      await call(first, "wait_task", {
        project,
        taskId: publishing.taskId,
        executionId: publishing.executionId,
        timeoutSeconds: 30,
      }),
    ).toMatchObject({ status: "completed", executionId: publishing.executionId });

    // The freed slot starts the queued task; both clients leave while its nested writer works.
    await waitFor(() => fixture.signalled("writer-running") || undefined, 15_000);
    await first.close();
    await second.close();

    const reconnected = await fixture.connect();
    const listed = await call(reconnected, "list_tasks", { project });
    expect(
      listed.tasks.map((task: { taskId: string; status: string }) => [task.taskId, task.status]),
    ).toEqual([
      [publishing.taskId, "completed"],
      [splitting.taskId, "running"],
    ]);
    const published = (
      await call(reconnected, "task_result", { project, taskId: publishing.taskId })
    ).result;
    expect(published).toMatchObject({
      summary: "Opened the pull request.",
      publication: { pushed: true, pullRequest: { number: 1, url: pullRequestUrl } },
    });
    expect(await eventTexts(reconnected, project, publishing.taskId)).toContain(
      `Needs input: request ${blocked.detail.requestId} asks to call mcp__tracker__create_issue.`,
    );
    const splittingEvents = await eventTexts(reconnected, project, splitting.taskId);
    expect(splittingEvents.findIndex((text) => text.startsWith("Waiting for a free slot"))).toBe(
      splittingEvents.indexOf("Running.") - 1,
    );

    fixture.release("writer-go");
    expect(
      await call(reconnected, "wait_task", {
        project,
        taskId: splitting.taskId,
        timeoutSeconds: 30,
      }),
    ).toMatchObject({ status: "completed" });
    const assembled = await call(reconnected, "task_result", { project, taskId: splitting.taskId });
    expect(assembled.result.workspace.commits).toMatchObject([{ subject: "docs: add notes" }]);
    expect(assembled.result.nestedWriters).toMatchObject([{ status: "completed" }]);

    // A follow-up resumes the publishing session, is told about its pull request, and the service dies mid-turn.
    const { sessionId } = await call(reconnected, "task_status", {
      project,
      taskId: publishing.taskId,
    });
    const followUp = await call(reconnected, "send_followup", {
      project,
      taskId: publishing.taskId,
      requestKey: "review-1",
      message: "Address the review comments.",
    });
    await waitFor(() => fixture.signalled("review-pushed") || undefined, 15_000);
    const resumed = fixture.launches().at(-1)!;
    expect(resumed.args).toContain(`--resume=${sessionId}`);
    expect(fixture.guidance().at(-1)).toContain(`pull request #1 (${pullRequestUrl}, state OPEN)`);
    const launched = fixture.launches().length;
    await fixture.killService();
    await waitFor(() => !isAlive(resumed.pid) || undefined);

    // The next service reports the follow-up as interrupted and reads what it published.
    const restarted = await fixture.connect();
    const interrupted = await waitFor(async () => {
      const status = await call(restarted, "task_status", { project, taskId: publishing.taskId });
      const execution = status.executions.find(
        (entry: { executionId: string }) => entry.executionId === followUp.executionId,
      );
      return execution.detail.recovery.reconciled ? execution : undefined;
    }, 15_000);
    const revision = git(published.workspace.path, "rev-parse", "HEAD");
    expect(git(origin, "rev-parse", `refs/heads/${published.workspace.branch}`)).toBe(revision);
    expect(interrupted).toMatchObject({
      status: "interrupted",
      reason: "service_restarted",
      detail: {
        recovery: { process: "ended", reconciled: true },
        workspace: { commitCount: 2 },
        publication: {
          revision,
          pushed: true,
          pullRequest: { number: 1, state: "OPEN", headRevision: revision },
        },
      },
    });
    expect(pullRequestCreations()).toBe(1);
    expect(fixture.launches()).toHaveLength(launched);
    expect(
      (await call(restarted, "task_result", { project, taskId: publishing.taskId })).result.summary,
    ).toBe("Opened the pull request.");

    // Once the parent has integrated the nested work, cleanup removes the task's and its writer's resources but keeps the results.
    git(project, "merge", "--quiet", "--ff-only", assembled.result.workspace.branch);
    const writer = assembled.result.nestedWriters[0];
    const cleanup = await call(restarted, "cleanup_task", { project, taskId: splitting.taskId });
    expect(cleanup).toMatchObject({
      outcome: "cleaned",
      worktree: { action: "removed" },
      branch: { action: "removed" },
      nestedWriters: [{ worktree: { action: "removed" }, branch: { action: "removed" } }],
    });
    for (const path of [assembled.result.workspace.path, writer.path]) {
      expect(existsSync(path)).toBe(false);
    }
    expect(git(project, "branch", "--list", writer.branch)).toBe("");
    const cleaned = await call(restarted, "task_status", { project, taskId: splitting.taskId });
    expect(cleaned.workspace.state).toBe("removed");
    expect(cleaned.executions[0].nestedWriters[0].workspace.state).toBe("removed");
    expect(await call(restarted, "task_result", { project, taskId: splitting.taskId })).toEqual(
      assembled,
    );
    expect(existsSync(published.workspace.path)).toBe(true);
  }, 90_000);
});
