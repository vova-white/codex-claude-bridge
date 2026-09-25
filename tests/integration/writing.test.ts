import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { Scenario, Step } from "../fixtures/fake-claude.ts";
import { BridgeFixture, waitFor, type BridgeClient } from "../support/bridge.ts";

const fixtures: BridgeFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

const commit = (message: string): Step => ({
  exec: [
    "git",
    "-c",
    "user.name=Child",
    "-c",
    "user.email=child@example.invalid",
    "commit",
    "-qam",
    message,
  ],
});

const finished = (summary: string): Step => ({
  result: {
    structured: {
      summary,
      evidence: ["ran the tests"],
      failures: [],
      remainingWork: [],
      checks: [{ command: "npm test", outcome: "passed" }],
    },
  },
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function setUp(scenario: Scenario) {
  const fixture = new BridgeFixture({ scenario });
  fixtures.push(fixture);
  const project = fixture.createRepository();
  const client = await fixture.connect();
  return { fixture, project, client };
}

function writeTask(project: string, overrides: Record<string, unknown> = {}) {
  return {
    project,
    requestKey: "write-1",
    mode: "write",
    assignment: "Improve the README wording.",
    expectedResult: "A committed README change.",
    ...overrides,
  };
}

async function run(client: BridgeClient, args: Record<string, unknown>) {
  const started = await client.call("start_task", args);
  expect(started.isError, started.text).toBe(false);
  const { taskId } = started.data;
  const waited = await client.call("wait_task", {
    project: args.project,
    taskId,
    timeoutSeconds: 30,
  });
  return { taskId, status: waited.data };
}

describe("writing tasks", () => {
  it("report commits and files without configured secrets, including staged-only changes", async () => {
    const fixture = new BridgeFixture({
      config: {
        mcpServers: { github: { command: "github-mcp", env: { TOKEN: "tok-COMMITSECRET" } } },
      },
      scenario: {
        turns: [
          {
            steps: [
              { writeFile: { path: "notes.txt", content: "n\n" } },
              { exec: ["git", "add", "notes.txt"] },
              commit("docs: add notes for tok-COMMITSECRET"),
              { writeFile: { path: "README.md", content: "# Staged\n" } },
              { exec: ["git", "add", "README.md"] },
              { writeFile: { path: "README.md", content: "# Fixture\n" } },
              finished("Done."),
            ],
          },
        ],
      },
    });
    fixtures.push(fixture);
    const project = fixture.createRepository();
    const client = await fixture.connect();
    const { taskId } = await run(client, writeTask(project));

    const result = await client.call("task_result", { project, taskId });
    expect(result.data.result.workspace).toMatchObject({
      commits: [{ subject: "docs: add notes for [REDACTED]" }],
      changedFiles: ["README.md", "notes.txt"],
    });
    expect(result.text).not.toContain("COMMITSECRET");
  });

  it("bound checks by maxChars and serve them in full through the result cursor", async () => {
    const details = `${"d".repeat(20_000)}-END`;
    const { project, client } = await setUp({
      turns: [
        {
          steps: [
            {
              result: {
                structured: {
                  summary: "Done.",
                  evidence: [],
                  failures: [],
                  remainingWork: [],
                  checks: [{ command: "npm test", outcome: "failed", details }],
                },
              },
            },
          ],
        },
      ],
    });
    const { taskId } = await run(client, writeTask(project));

    const first = (await client.call("task_result", { project, taskId, maxChars: 200 })).data;
    expect(first.result.checks).toEqual([
      { command: "npm test", outcome: "failed", details: expect.any(String), complete: false },
    ]);
    expect(first.result.checks[0].details.length).toBeLessThan(200);
    let text = `npm test\n${first.result.checks[0].details}`;
    let next = first.truncated.next;
    while (next) {
      const page = (
        await client.call("task_result", { project, taskId, maxChars: 16_000, ...next })
      ).data;
      text += page.parts.map((part: { text: string }) => part.text).join("");
      next = page.truncated?.next;
    }
    expect(text).toBe(`npm test\n${details}`);
  });

  it("return one task for concurrent identical submissions", async () => {
    const { project, client } = await setUp({ turns: [{ steps: [finished("Done.")] }] });
    const results = await Promise.all(
      Array.from({ length: 5 }, () => client.call("start_task", writeTask(project))),
    );
    expect(results.map((result) => result.isError)).toEqual([false, false, false, false, false]);
    expect(new Set(results.map((result) => result.data.taskId)).size).toBe(1);
    expect(results.filter((result) => result.data.created)).toHaveLength(1);
  });

  it("run follow-ups in the task's worktree", async () => {
    const { fixture, project, client } = await setUp({
      turns: [
        {
          match: "Also",
          steps: [{ writeFile: { path: "more.txt", content: "m\n" } }, finished("More.")],
        },
        { steps: [finished("First.")] },
      ],
    });
    const { taskId } = await run(client, writeTask(project));
    const sent = await client.call("send_followup", {
      project,
      taskId,
      requestKey: "more-1",
      message: "Also add more.txt.",
    });
    await client.call("wait_task", {
      project,
      taskId,
      executionId: sent.data.executionId,
      timeoutSeconds: 30,
    });

    const launches = fixture.launches();
    expect(launches).toHaveLength(2);
    expect(launches[1]!.cwd).toBe(launches[0]!.cwd);
    const later = await client.call("task_result", {
      project,
      taskId,
      executionId: sent.data.executionId,
    });
    expect(later.data.result.workspace.changedFiles).toEqual(["more.txt"]);
  });

  it("work on their own branch and worktree from a recorded baseline and report the change set", async () => {
    const { fixture, project, client } = await setUp({
      turns: [
        {
          steps: [
            { writeFile: { path: "README.md", content: "# Better fixture\n" } },
            commit("docs: improve the README"),
            finished("Reworded the README."),
          ],
        },
      ],
    });
    const baseline = git(project, "rev-parse", "HEAD");
    const { taskId, status } = await run(client, writeTask(project, { branchType: "bugfix" }));
    expect(status.status).toBe("completed");

    const { result } = (await client.call("task_result", { project, taskId })).data;
    const { workspace } = result;
    expect(workspace).toMatchObject({
      kind: "worktree",
      baseline,
      parentDirty: false,
      changedFiles: ["README.md"],
      commits: [{ subject: "docs: improve the README" }],
    });
    expect(workspace.branch).toMatch(/^bugfix\/improve-the-readme-wording-[0-9a-f]{8}$/);
    expect(workspace.isolation).toContain("not an operating-system sandbox");
    expect(result.checks).toEqual([{ command: "npm test", outcome: "passed" }]);

    expect(fixture.launches()[0]!.cwd).toBe(workspace.path);
    expect(git(workspace.path, "branch", "--show-current")).toBe(workspace.branch);
    expect(readFileSync(join(project, "README.md"), "utf8")).toBe("# Fixture\n");
    expect(git(project, "rev-parse", "HEAD")).toBe(baseline);
    expect(git(project, "status", "--porcelain")).toBe("");
  });

  it("refuse a dirty parent unless a committed baseline is chosen explicitly", async () => {
    const { fixture, project, client } = await setUp({ turns: [{ steps: [finished("Done.")] }] });
    writeFileSync(join(project, "draft.txt"), "uncommitted\n");

    const refused = await client.call("start_task", writeTask(project));
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("uncommitted changes");
    expect(fixture.launches()).toEqual([]);

    const { taskId, status } = await run(
      client,
      writeTask(project, { requestKey: "write-2", baseline: "HEAD" }),
    );
    expect(status.status).toBe("completed");
    const { workspace } = (await client.call("task_status", { project, taskId })).data;
    expect(workspace).toMatchObject({
      parentDirty: true,
      baseline: git(project, "rev-parse", "HEAD"),
    });
    expect(existsSync(join(workspace.path, "draft.txt"))).toBe(false);
  });

  it("give concurrent writers separate worktrees and branches with independent changes", async () => {
    const { project, client } = await setUp({
      turns: [
        {
          match: "alpha",
          steps: [{ writeFile: { path: "alpha.txt", content: "a\n" } }, finished("Alpha.")],
        },
        {
          match: "beta",
          steps: [{ writeFile: { path: "beta.txt", content: "b\n" } }, finished("Beta.")],
        },
      ],
    });
    const [alpha, beta] = await Promise.all([
      run(client, writeTask(project, { requestKey: "alpha", assignment: "Add alpha." })),
      run(client, writeTask(project, { requestKey: "beta", assignment: "Add beta." })),
    ]);
    const workspaces = await Promise.all(
      [alpha, beta].map(
        async ({ taskId }) =>
          (await client.call("task_result", { project, taskId })).data.result.workspace,
      ),
    );

    expect(workspaces[0].path).not.toBe(workspaces[1].path);
    expect(workspaces[0].branch).not.toBe(workspaces[1].branch);
    expect(workspaces.map((workspace) => workspace.changedFiles)).toEqual([
      ["alpha.txt"],
      ["beta.txt"],
    ]);
    expect(existsSync(join(workspaces[0].path, "beta.txt"))).toBe(false);
    expect(existsSync(join(project, "alpha.txt"))).toBe(false);
  });

  it("create one worktree for repeated submissions", async () => {
    const { project, client } = await setUp({ turns: [{ steps: [finished("Done.")] }] });
    const first = await run(client, writeTask(project));
    const again = await client.call("start_task", writeTask(project));
    expect(again.data).toMatchObject({ taskId: first.taskId, created: false });

    const worktrees = git(project, "worktree", "list", "--porcelain")
      .split("\n")
      .filter((line) => line.startsWith("worktree "));
    expect(worktrees).toHaveLength(2);
  });

  it("fail cleanly when the worktree cannot be created", async () => {
    const { fixture, project, client } = await setUp({ turns: [{ steps: [finished("Done.")] }] });
    const worktrees = join(fixture.stateDir, "worktrees");
    mkdirSync(worktrees, { mode: 0o500 });
    chmodSync(worktrees, 0o500);

    const { taskId, status } = await run(client, writeTask(project));
    expect(status).toMatchObject({ status: "failed", reason: "workspace_error", terminal: true });
    expect(fixture.launches()).toEqual([]);
    expect(
      git(project, "worktree", "list", "--porcelain")
        .split("\n")
        .filter((line) => line.startsWith("worktree ")),
    ).toHaveLength(1);
    expect(git(project, "branch", "--list", "feature/*")).toBe("");
    const listed = (await client.call("task_status", { project, taskId })).data;
    expect(listed.workspace.state).toBe("failed");
    chmodSync(worktrees, 0o700);
  });

  it("retain the worktree and its changes after failure and cancellation", async () => {
    const { fixture, project, client } = await setUp({
      turns: [
        {
          match: "Fail",
          steps: [{ writeFile: { path: "partial.txt", content: "p\n" } }, { exit: { code: 1 } }],
        },
        {
          match: "Stop",
          steps: [{ writeFile: { path: "stopped.txt", content: "s\n" } }, { waitFor: "never" }],
        },
      ],
    });
    const failed = await run(
      client,
      writeTask(project, { requestKey: "fail", assignment: "Fail midway." }),
    );
    expect(failed.status.status).toBe("failed");
    expect(failed.status.error.workspace).toMatchObject({ changedFiles: ["partial.txt"] });
    expect(existsSync(join(failed.status.error.workspace.path, "partial.txt"))).toBe(true);

    const started = await client.call(
      "start_task",
      writeTask(project, { requestKey: "stop", assignment: "Stop midway." }),
    );
    const { taskId } = started.data;
    await waitFor(
      () => fixture.prompts().some((prompt) => prompt.includes("Stop midway")) || undefined,
    );
    const cancelled = (await client.call("cancel_task", { project, taskId })).data;
    const [execution] = cancelled.executions;
    expect(execution).toMatchObject({ status: "cancelled", detail: { processExited: true } });
    expect(execution.detail.workspace.changedFiles).toEqual(["stopped.txt"]);
    expect(existsSync(join(execution.detail.workspace.path, "stopped.txt"))).toBe(true);
  });
});
