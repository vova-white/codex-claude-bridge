import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { Scenario, Step } from "../fixtures/fake-claude.ts";
import { BridgeFixture, waitFor, type BridgeClient } from "../support/bridge.ts";

const fixtures: BridgeFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

const commit = (file: string): Step[] => [
  { writeFile: { path: file, content: `${file}\n` } },
  { exec: ["git", "add", file] },
  {
    exec: [
      "git",
      "-c",
      "user.name=Child",
      "-c",
      "user.email=child@example.invalid",
      "commit",
      "-qm",
      `feat: add ${file}`,
    ],
  },
];

const finished = (summary: string): Step => ({
  result: {
    structured: { summary, evidence: [], failures: [], remainingWork: [], checks: [] },
  },
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Parent",
      GIT_AUTHOR_EMAIL: "parent@example.invalid",
      GIT_COMMITTER_NAME: "Parent",
      GIT_COMMITTER_EMAIL: "parent@example.invalid",
    },
  }).trim();
}

const branchExists = (project: string, branch: string) =>
  git(project, "branch", "--list", branch) !== "";

async function setUp(scenario: Scenario) {
  const fixture = new BridgeFixture({ scenario });
  fixtures.push(fixture);
  const project = fixture.createRepository();
  const client = await fixture.connect();
  return { fixture, project, client };
}

/** Starts a writing task whose assignment selects the scenario turn, and waits for it to end. */
async function run(client: BridgeClient, project: string, assignment: string) {
  const started = await client.call("start_task", {
    project,
    requestKey: assignment,
    mode: "write",
    assignment,
    expectedResult: "Committed changes.",
  });
  expect(started.isError, started.text).toBe(false);
  const { taskId } = started.data;
  const waited = await client.call("wait_task", { project, taskId, timeoutSeconds: 30 });
  const { workspace } = (await client.call("task_status", { project, taskId })).data;
  return { taskId, status: waited.data, workspace };
}

async function cleanup(
  client: BridgeClient,
  project: string,
  taskId: string,
  options: Record<string, unknown> = {},
) {
  const response = await client.call("cleanup_task", { project, taskId, ...options });
  expect(response.isError, response.text).toBe(false);
  return response.data;
}

describe("task cleanup", () => {
  it("keeps worktrees and branches after success, failure, and cancellation until cleanup", async () => {
    const { fixture, project, client } = await setUp({
      turns: [
        { match: "Succeed", steps: [...commit("done.txt"), finished("Done.")] },
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
    const succeeded = await run(client, project, "Succeed here.");
    const failed = await run(client, project, "Fail midway.");
    const started = await client.call("start_task", {
      project,
      requestKey: "stop",
      mode: "write",
      assignment: "Stop midway.",
      expectedResult: "Nothing.",
    });
    const stopped = started.data.taskId;
    await waitFor(
      () => fixture.prompts().some((text) => text.includes("Stop midway")) || undefined,
    );
    expect((await client.call("cancel_task", { project, taskId: stopped })).data.cancellation).toBe(
      "confirmed",
    );
    const cancelled = (await client.call("task_status", { project, taskId: stopped })).data;

    expect([succeeded.status.status, failed.status.status, cancelled.status]).toEqual([
      "completed",
      "failed",
      "cancelled",
    ]);
    for (const [workspace, file] of [
      [succeeded.workspace, "done.txt"],
      [failed.workspace, "partial.txt"],
      [cancelled.workspace, "stopped.txt"],
    ] as const) {
      expect(workspace.state).toBe("ready");
      expect(existsSync(join(workspace.path, file))).toBe(true);
      expect(branchExists(project, workspace.branch)).toBe(true);
    }

    const plan = await cleanup(client, project, succeeded.taskId, { dryRun: true });
    expect(plan).toMatchObject({
      outcome: "refused",
      dryRun: true,
      scope: "all",
      worktree: { path: succeeded.workspace.path, action: "keep", uncommittedChanges: false },
      branch: { name: succeeded.workspace.branch, action: "keep", unintegratedCommits: 1 },
      refusals: [{ code: "unintegrated_commits" }],
    });
    const worktreeOnly = await cleanup(client, project, succeeded.taskId, {
      dryRun: true,
      scope: "worktree",
    });
    expect(worktreeOnly).toMatchObject({
      outcome: "planned",
      worktree: { action: "remove" },
      branch: { action: "keep" },
    });
    expect(existsSync(succeeded.workspace.path)).toBe(true);
    expect(branchExists(project, succeeded.workspace.branch)).toBe(true);
  });

  it("refuses to discard uncommitted or unintegrated work unless the caller decides to", async () => {
    const { project, client } = await setUp({
      turns: [
        {
          steps: [
            ...commit("feature.txt"),
            { writeFile: { path: "draft.txt", content: "d\n" } },
            finished("Done."),
          ],
        },
      ],
    });
    const { taskId, workspace } = await run(client, project, "Add a feature.");

    const dirty = await cleanup(client, project, taskId, { scope: "worktree" });
    expect(dirty).toMatchObject({
      outcome: "refused",
      worktree: { action: "keep", uncommittedChanges: true },
      refusals: [{ code: "uncommitted_changes" }],
    });
    expect(dirty.refusals[0].message).toContain(workspace.path);
    expect(existsSync(join(workspace.path, "draft.txt"))).toBe(true);

    rmSync(join(workspace.path, "draft.txt"));
    const unmerged = await cleanup(client, project, taskId);
    expect(unmerged).toMatchObject({
      outcome: "refused",
      branch: { action: "keep", unintegratedCommits: 1 },
      refusals: [{ code: "unintegrated_commits" }],
    });
    expect(unmerged.refusals[0].message).toContain(workspace.branch);
    expect(existsSync(workspace.path)).toBe(true);

    const kept = await cleanup(client, project, taskId, { scope: "worktree" });
    expect(kept).toMatchObject({
      outcome: "cleaned",
      worktree: { action: "removed" },
      branch: { action: "keep" },
      workspace: { state: "branch_kept" },
    });
    expect(existsSync(workspace.path)).toBe(false);
    expect(git(project, "log", "--format=%s", "-1", workspace.branch)).toBe(
      "feat: add feature.txt",
    );

    const discarded = await cleanup(client, project, taskId, { discardUnintegrated: true });
    expect(discarded).toMatchObject({
      outcome: "cleaned",
      worktree: { action: "already_removed" },
      branch: { action: "removed" },
      workspace: { state: "removed" },
    });
    expect(branchExists(project, workspace.branch)).toBe(false);
  });

  it("discards a dirty worktree only with an explicit decision", async () => {
    const { project, client } = await setUp({
      turns: [{ steps: [{ writeFile: { path: "draft.txt", content: "d\n" } }, finished("Done.")] }],
    });
    const { taskId, workspace } = await run(client, project, "Draft something.");

    const removed = await cleanup(client, project, taskId, { discardUnintegrated: true });
    expect(removed).toMatchObject({
      outcome: "cleaned",
      worktree: { action: "removed", uncommittedChanges: true },
      branch: { action: "removed", unintegratedCommits: 0 },
    });
    expect(existsSync(workspace.path)).toBe(false);
    expect(branchExists(project, workspace.branch)).toBe(false);
  });

  it("refuses while an execution is active, whatever the caller decides", async () => {
    const { fixture, project, client } = await setUp({
      turns: [{ steps: [{ waitFor: "never" }] }],
    });
    const started = await client.call("start_task", {
      project,
      requestKey: "busy",
      mode: "write",
      assignment: "Work for a while.",
      expectedResult: "Nothing.",
    });
    const { taskId } = started.data;
    await waitFor(() => fixture.prompts().length > 0 || undefined);

    const refused = await cleanup(client, project, taskId, { discardUnintegrated: true });
    expect(refused).toMatchObject({
      outcome: "refused",
      refusals: [{ code: "active_execution" }],
    });
    expect(refused.refusals[0].message).toContain(started.data.executionId);
    const { workspace } = (await client.call("task_status", { project, taskId })).data;
    expect(existsSync(workspace.path)).toBe(true);

    await client.call("cancel_task", { project, taskId });
    expect(await cleanup(client, project, taskId)).toMatchObject({ outcome: "cleaned" });
    expect(existsSync(workspace.path)).toBe(false);
  });

  it("deletes integrated branches, keeps unrelated checkouts and results, and repeats safely", async () => {
    const { fixture, project, client } = await setUp({
      turns: [
        { match: "merged", steps: [...commit("merged.txt"), finished("Merged.")] },
        { match: "pushed", steps: [...commit("pushed.txt"), finished("Pushed.")] },
        { match: "other", steps: [...commit("other.txt"), finished("Other.")] },
      ],
    });
    const merged = await run(client, project, "Change merged.");
    const pushed = await run(client, project, "Change pushed.");
    const other = await run(client, project, "Change other.");
    git(project, "merge", "--quiet", "--no-edit", "--no-ff", merged.workspace.branch);
    const remote = join(fixture.root, "remote.git");
    git(fixture.root, "init", "--quiet", "--bare", remote);
    git(project, "remote", "add", "origin", remote);
    git(project, "push", "--quiet", "origin", pushed.workspace.branch);
    const unrelated = join(fixture.root, "unrelated");
    git(project, "worktree", "add", "--quiet", "-b", "user/topic", unrelated);
    writeFileSync(join(unrelated, "mine.txt"), "mine\n");
    writeFileSync(join(project, "parent-draft.txt"), "draft\n");
    const head = git(project, "rev-parse", "HEAD");

    for (const task of [merged, pushed]) {
      const report = await cleanup(client, project, task.taskId);
      expect(report).toMatchObject({
        outcome: "cleaned",
        worktree: { path: task.workspace.path, action: "removed" },
        branch: { name: task.workspace.branch, action: "removed", unintegratedCommits: 0 },
        workspace: { state: "removed" },
      });
      expect(existsSync(task.workspace.path)).toBe(false);
      expect(branchExists(project, task.workspace.branch)).toBe(false);
    }
    const repeated = await cleanup(client, project, merged.taskId);
    expect(repeated).toMatchObject({
      outcome: "cleaned",
      worktree: { action: "already_removed" },
      branch: { action: "already_removed" },
      workspace: { state: "removed" },
    });

    expect(git(project, "rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(join(project, "parent-draft.txt"), "utf8")).toBe("draft\n");
    expect(readFileSync(join(unrelated, "mine.txt"), "utf8")).toBe("mine\n");
    expect(existsSync(join(other.workspace.path, "other.txt"))).toBe(true);
    expect(branchExists(project, other.workspace.branch)).toBe(true);
    expect(git(remote, "branch", "--list", pushed.workspace.branch)).not.toBe("");
    const result = await client.call("task_result", { project, taskId: merged.taskId });
    expect(result.data.result).toMatchObject({
      summary: "Merged.",
      workspace: { commits: [{ subject: "feat: add merged.txt" }] },
    });
    const status = (await client.call("task_status", { project, taskId: merged.taskId })).data;
    expect(status).toMatchObject({ status: "completed", workspace: { state: "removed" } });
  });

  it("reports a partial failure per resource and finishes on a later call", async () => {
    const { project, client } = await setUp({
      turns: [{ steps: [...commit("feature.txt"), finished("Done.")] }],
    });
    const { taskId, workspace } = await run(client, project, "Add a feature.");
    git(project, "merge", "--quiet", "--ff-only", workspace.branch);
    const lock = join(project, ".git", "refs", "heads", `${workspace.branch}.lock`);
    writeFileSync(lock, "");

    const partial = await cleanup(client, project, taskId);
    expect(partial).toMatchObject({
      outcome: "partial",
      worktree: { action: "removed" },
      branch: { action: "failed" },
      failures: [{ resource: "branch" }],
      workspace: { state: "branch_kept" },
    });
    expect(branchExists(project, workspace.branch)).toBe(true);

    rmSync(lock);
    expect(await cleanup(client, project, taskId)).toMatchObject({
      outcome: "cleaned",
      worktree: { action: "already_removed" },
      branch: { action: "removed" },
      workspace: { state: "removed" },
    });
  });

  it("refuses follow-ups once the worktree is removed, and read-only tasks have nothing to clean", async () => {
    const { fixture, project, client } = await setUp({
      turns: [{ steps: [finished("Done.")] }],
    });
    const { taskId, workspace } = await run(client, project, "Change nothing.");
    await cleanup(client, project, taskId, { scope: "worktree" });

    const followUp = await client.call("send_followup", {
      project,
      taskId,
      requestKey: "after-cleanup",
      message: "Continue.",
    });
    expect(followUp.isError).toBe(true);
    expect(followUp.text).toContain("was removed by cleanup_task");
    expect(followUp.text).toContain(workspace.branch);
    expect(fixture.launches()).toHaveLength(1);
    expect(existsSync(workspace.path)).toBe(false);

    const readOnly = await client.call("start_task", {
      project,
      requestKey: "read",
      assignment: "Read.",
      expectedResult: "Findings.",
    });
    const refused = await client.call("cleanup_task", {
      project,
      taskId: readOnly.data.taskId,
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("no worktree");
  });
});
