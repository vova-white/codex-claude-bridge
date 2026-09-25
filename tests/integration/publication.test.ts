import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { Scenario, Step } from "../fixtures/fake-claude.ts";
import type { FakeGitHub } from "../fixtures/fake-gh.ts";
import { BridgeFixture, isAlive, waitFor, type BridgeClient } from "../support/bridge.ts";

const fakeGh = resolve("tests/fixtures/fake-gh.ts");
const fixtures: BridgeFixture[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
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
const push: Step = { exec: ["git", "push", "--quiet", "-u", "origin", "HEAD"] };
const createPullRequest: Step = {
  exec: ["gh", "pr", "create", "--title", "docs: improve the README", "--body", "Rewords it."],
};
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

/**
 * A bridge whose project has a local bare repository as `origin` and whose
 * service finds the fake GitHub CLI first on its PATH.
 */
async function setUp(scenario: Scenario, initial: FakeGitHub = { pullRequests: [] }) {
  const bin = mkdtempSync(join(tmpdir(), "bridge-gh-"));
  directories.push(bin);
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/sh\nFAKE_GH_DIR='${bin}' exec '${process.execPath}' '${fakeGh}' "$@"\n`,
    { mode: 0o755 },
  );
  writeFileSync(join(bin, "gh-state.json"), JSON.stringify(initial));
  const fixture = new BridgeFixture({
    scenario,
    env: { PATH: `${bin}:${process.env.PATH ?? ""}` },
  });
  fixtures.push(fixture);
  const project = fixture.createRepository();
  const origin = join(fixture.root, "origin.git");
  git(fixture.root, "init", "--quiet", "--bare", origin);
  git(project, "remote", "add", "origin", origin);
  git(project, "push", "--quiet", "origin", "main");
  const client = await fixture.connect();
  const ghCalls = (): string[][] => {
    const log = join(bin, "gh-calls.jsonl");
    if (!existsSync(log)) return [];
    return readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line).args);
  };
  /** Changes what the fake GitHub serves from now on. */
  const github = (change: (state: FakeGitHub) => void) => {
    const path = join(bin, "gh-state.json");
    const state = JSON.parse(readFileSync(path, "utf8")) as FakeGitHub;
    change(state);
    writeFileSync(path, JSON.stringify(state));
  };
  return { fixture, project, origin, client, ghCalls, github, bin };
}

function writeTask(project: string, overrides: Record<string, unknown> = {}) {
  return {
    project,
    requestKey: "publish-1",
    mode: "write",
    publish: "pull_request",
    assignment: "Improve the README wording.",
    expectedResult: "A pull request with the README change.",
    ...overrides,
  };
}

async function run(client: BridgeClient, args: Record<string, unknown>) {
  const started = await client.call("start_task", args);
  expect(started.isError, started.text).toBe(false);
  const { taskId, executionId } = started.data;
  const waited = await client.call("wait_task", {
    project: args.project,
    taskId,
    executionId,
    timeoutSeconds: 30,
  });
  return { taskId, status: waited.data };
}

async function followUp(client: BridgeClient, project: string, taskId: string, message: string) {
  const sent = await client.call("send_followup", {
    project,
    taskId,
    requestKey: `follow-${message}`,
    message,
  });
  expect(sent.isError, sent.text).toBe(false);
  await client.call("wait_task", {
    project,
    taskId,
    executionId: sent.data.executionId,
    timeoutSeconds: 30,
  });
  return (await client.call("task_result", { project, taskId, executionId: sent.data.executionId }))
    .data;
}

const pullRequestUrl = "https://github.example/owner/repo/pull/1";
const creates = (calls: string[][]) =>
  calls.filter((args) => args[0] === "pr" && args[1] === "create");

describe("task publication", () => {
  it("record the pushed branch and pull request the bridge finds on the remote", async () => {
    const { fixture, project, origin, client } = await setUp({
      turns: [
        {
          steps: [
            ...commit("README.md", "# Better fixture\n", "docs: improve the README"),
            push,
            createPullRequest,
            finished("Opened the pull request."),
          ],
        },
      ],
    });
    const { taskId, status } = await run(client, writeTask(project));
    expect(status.status).toBe("completed");

    const { result } = (await client.call("task_result", { project, taskId })).data;
    const revision = git(result.workspace.path, "rev-parse", "HEAD");
    expect(result.publication).toEqual({
      mode: "pull_request",
      repository: origin,
      remote: "origin",
      branch: result.workspace.branch,
      revision,
      pushedRevision: revision,
      pushed: true,
      pullRequest: { number: 1, url: pullRequestUrl, state: "OPEN", headRevision: revision },
      checkedAt: expect.any(String),
      concerns: [],
    });
    expect(result.checks).toEqual([{ command: "npm test", outcome: "passed" }]);
    expect(git(origin, "rev-parse", `refs/heads/${result.workspace.branch}`)).toBe(revision);
    const status2 = (await client.call("task_status", { project, taskId })).data;
    expect(status2.publication.pullRequest.url).toBe(pullRequestUrl);

    const guidance = fixture.guidance()[0]!;
    expect(guidance).toContain("gh pr create");
    expect(guidance).toContain("Never merge or close the pull request");
    expect(guidance).not.toContain("Do not push");
  });

  it("publish only the task branch once the executor assembled its nested writer's work", async () => {
    const { fixture, project, origin, client } = await setUp({
      turns: [
        {
          match: "Nested writer",
          steps: [
            ...commit("NOTES.md", "notes\n", "docs: add notes"),
            finished("Added the notes."),
          ],
        },
        {
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
            ...commit("README.md", "# Better fixture\n", "docs: improve the README"),
            push,
            createPullRequest,
            finished("Assembled the notes and opened the pull request."),
          ],
        },
      ],
    });
    const { taskId, status } = await run(client, writeTask(project));
    expect(status.status).toBe("completed");

    const { result } = (await client.call("task_result", { project, taskId })).data;
    const [writer] = result.nestedWriters;
    const revision = git(result.workspace.path, "rev-parse", "HEAD");
    expect(git(result.workspace.path, "log", "--format=%s", revision)).toContain("docs: add notes");
    expect(result.publication).toMatchObject({
      revision,
      pushedRevision: revision,
      pushed: true,
      pullRequest: { number: 1, headRevision: revision },
      concerns: [],
    });
    expect(git(origin, "for-each-ref", "--format=%(refname:short)", "refs/heads")).toBe(
      ["main", result.workspace.branch].toSorted().join("\n"),
    );
    expect(writer.branch).not.toBe(result.workspace.branch);
    expect(fixture.guidance()[0]!).toContain("never a nested writer's branch");
  });

  it("point publication actions at the project once cleanup removed the worktree", async () => {
    const { project, client } = await setUp({
      turns: [
        {
          steps: [
            ...commit("README.md", "# Better fixture\n", "docs: improve the README"),
            push,
            createPullRequest,
            ...commit("NOTES.md", "notes\n", "docs: add notes"),
            finished("Opened the pull request."),
          ],
        },
      ],
    });
    const { taskId, status } = await run(client, writeTask(project));
    expect(status.status).toBe("completed");
    const before = (await client.call("task_status", { project, taskId })).data.publication;
    expect(before.concerns.map((concern: { code: string }) => concern.code)).toEqual([
      "unpushed_commits",
    ]);

    const cleanup = await client.call("cleanup_task", { project, taskId, scope: "worktree" });
    expect(cleanup.data.outcome).toBe("cleaned");
    const { workspace, publication } = (await client.call("task_status", { project, taskId })).data;
    expect(workspace.state).toBe("branch_kept");
    expect(publication.concerns).toEqual([
      {
        code: "unpushed_commits",
        message: expect.any(String),
        action: `Push it yourself with \`git -C ${project} push origin ${workspace.branch}\`.`,
      },
    ]);
  });

  it("have a follow-up update the existing pull request instead of creating another", async () => {
    const { fixture, project, client, ghCalls } = await setUp({
      turns: [
        {
          match: "Also",
          steps: [
            ...commit("more.txt", "m\n", "docs: add more notes"),
            push,
            finished("Pushed to the pull request."),
          ],
        },
        {
          steps: [
            ...commit("README.md", "# Better fixture\n", "docs: improve the README"),
            push,
            createPullRequest,
            finished("Opened the pull request."),
          ],
        },
      ],
    });
    const { taskId } = await run(client, writeTask(project));
    const first = (await client.call("task_result", { project, taskId })).data.result.publication;

    const later = (await followUp(client, project, taskId, "Also add more notes.")).result;
    const followUpGuidance = fixture.guidance()[1]!;
    expect(followUpGuidance).toContain(`pull request #1 (${pullRequestUrl}, state OPEN)`);
    expect(followUpGuidance).toContain("Update it rather than creating another");
    expect(creates(ghCalls())).toHaveLength(1);
    expect(later.publication).toMatchObject({
      pushed: true,
      pullRequest: { number: 1, url: pullRequestUrl, headRevision: later.publication.revision },
      concerns: [],
    });
    expect(later.publication.revision).not.toBe(first.revision);
  });

  it("reconcile an unreported publication from the remote", async () => {
    const { fixture, project, client, ghCalls } = await setUp({
      turns: [
        { match: "Finish", steps: [finished("Nothing left to publish.")] },
        {
          steps: [
            ...commit("README.md", "# Better fixture\n", "docs: improve the README"),
            push,
            createPullRequest,
            { exit: { code: 1 } },
          ],
        },
      ],
    });
    const { taskId, status } = await run(client, writeTask(project));
    expect(status).toMatchObject({ status: "failed", reason: "provider_error" });
    expect(status.detail.publication).toMatchObject({
      pushed: true,
      pullRequest: { number: 1, url: pullRequestUrl, state: "OPEN" },
    });

    await followUp(client, project, taskId, "Finish the task.");
    expect(fixture.guidance()[1]!).toContain(`pull request #1 (${pullRequestUrl}`);
    expect(creates(ghCalls())).toHaveLength(1);
  });

  it("keep local commits and report an action when the push is rejected", async () => {
    const { project, origin, client, ghCalls } = await setUp({
      turns: [
        {
          steps: [
            ...commit("README.md", "# Better fixture\n", "docs: improve the README"),
            { ...push, mayFail: true },
            finished("Committed, but the push failed.", ["git push was rejected by the remote."]),
          ],
        },
      ],
    });
    writeFileSync(join(origin, "hooks", "pre-receive"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });

    const { taskId, status } = await run(client, writeTask(project));
    expect(status.status).toBe("completed");
    const { result } = (await client.call("task_result", { project, taskId })).data;
    const { workspace, publication } = result;
    expect(result.failures).toEqual(["git push was rejected by the remote."]);
    expect(publication).toMatchObject({ pushed: false, pushedRevision: null, pullRequest: null });
    expect(publication.concerns).toEqual([
      {
        code: "not_pushed",
        message: expect.stringContaining("exist only locally"),
        action: expect.stringContaining(`git -C ${workspace.path} push origin ${workspace.branch}`),
      },
    ]);
    expect(git(workspace.path, "log", "-1", "--format=%s")).toBe("docs: improve the README");
    expect(readFileSync(join(workspace.path, "README.md"), "utf8")).toBe("# Better fixture\n");
    expect(git(origin, "for-each-ref", "--format=%(refname:short)", "refs/heads")).toBe("main");
    expect(creates(ghCalls())).toEqual([]);
  });

  it("report a merged pull request truthfully after its branch was deleted", async () => {
    const { fixture, project, origin, client, github } = await setUp({
      turns: [
        { match: "Anything", steps: [finished("Nothing left.")] },
        {
          steps: [
            ...commit("README.md", "# Better fixture\n", "docs: improve the README"),
            push,
            createPullRequest,
            finished("Opened the pull request."),
          ],
        },
      ],
    });
    const { taskId } = await run(client, writeTask(project));
    const { workspace } = (await client.call("task_result", { project, taskId })).data.result;
    const revision = git(workspace.path, "rev-parse", "HEAD");
    git(origin, "branch", "-D", workspace.branch);
    github((state) => {
      state.pullRequests[0]!.state = "MERGED";
    });

    const { publication } = (await followUp(client, project, taskId, "Anything left?")).result;
    expect(publication).toMatchObject({
      pushedRevision: null,
      pushed: false,
      pullRequest: { number: 1, state: "MERGED", headRevision: revision },
    });
    expect(publication.concerns).toEqual([
      {
        code: "branch_not_on_remote",
        message: expect.stringContaining("pull request #1 is MERGED"),
      },
    ]);
    expect(fixture.guidance()[1]!).toContain(`pull request #1 (${pullRequestUrl}, state MERGED)`);
  });

  it("check the push destination when the remote pushes elsewhere than it fetches", async () => {
    const { fixture, project, origin, client, bin } = await setUp({
      turns: [
        {
          steps: [
            ...commit("README.md", "# Better fixture\n", "docs: improve the README"),
            push,
            createPullRequest,
            finished("Opened the pull request."),
          ],
        },
      ],
    });
    const destination = join(fixture.root, "push.git");
    git(fixture.root, "init", "--quiet", "--bare", destination);
    git(project, "remote", "set-url", "--push", "origin", destination);
    // Records every command line the service and Claude give Git, since a push URL may hold credentials.
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    const gitCalls = join(bin, "git-calls.log");
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\necho "$*" >> '${gitCalls}'\nexec '${realGit}' "$@"\n`,
      {
        mode: 0o755,
      },
    );

    const { taskId } = await run(client, writeTask(project));
    const { result } = (await client.call("task_result", { project, taskId })).data;
    const revision = git(result.workspace.path, "rev-parse", "HEAD");
    expect(result.publication).toMatchObject({
      repository: destination,
      pushedRevision: revision,
      pushed: true,
      pullRequest: { number: 1, headRevision: revision },
      concerns: [],
    });
    expect(git(origin, "for-each-ref", "--format=%(refname:short)", "refs/heads")).toBe("main");
    const calls = readFileSync(gitCalls, "utf8");
    expect(calls).toContain("ls-remote");
    expect(calls).not.toContain(destination);
  });

  it("cancel a follow-up during the remote check without starting Claude", async () => {
    const { fixture, project, client, ghCalls, github } = await setUp({
      turns: [
        {
          steps: [
            ...commit("README.md", "# Better fixture\n", "docs: improve the README"),
            push,
            createPullRequest,
            finished("Opened the pull request."),
          ],
        },
      ],
    });
    const { taskId } = await run(client, writeTask(project));
    const checked = (await client.call("task_status", { project, taskId })).data.publication;
    github((state) => {
      state.listWaitsFor = "never";
    });
    const listed = ghCalls().length;
    await client.call("send_followup", { project, taskId, requestKey: "more", message: "More." });
    await waitFor(() => ghCalls().length > listed || undefined);

    const cancelled = (await client.call("cancel_task", { project, taskId })).data;
    expect(cancelled).toMatchObject({
      cancellation: "confirmed",
      executions: [{ status: "cancelled" }],
    });
    expect(fixture.launches()).toHaveLength(1);
    const status = (await client.call("task_status", { project, taskId })).data;
    expect(status.publication).toEqual(checked);
  });

  it("find a pull request published before a service restart when a follow-up starts", async () => {
    const { fixture, project, client, ghCalls } = await setUp({
      turns: [
        { match: "Continue", steps: [finished("Continued.")] },
        {
          steps: [
            ...commit("README.md", "# Better fixture\n", "docs: improve the README"),
            push,
            createPullRequest,
            { signal: "published" },
            { waitFor: "never" },
          ],
        },
      ],
    });
    const started = await client.call("start_task", writeTask(project));
    const { taskId } = started.data;
    await waitFor(() => fixture.signalled("published") || undefined, 15_000);
    const pid = fixture.servicePid()!;
    process.kill(pid, "SIGKILL");
    await waitFor(() => !isAlive(pid) || undefined);

    const reconnected = await fixture.connect();
    const status = (await reconnected.call("task_status", { project, taskId })).data;
    expect(status.status).toBe("interrupted");
    const { publication } = (await followUp(reconnected, project, taskId, "Continue.")).result;
    expect(fixture.guidance()[1]!).toContain(`pull request #1 (${pullRequestUrl}, state OPEN)`);
    expect(publication).toMatchObject({ pushed: true, pullRequest: { number: 1 } });
    expect(creates(ghCalls())).toHaveLength(1);
  });

  it("reconcile what an execution interrupted by a service crash published, without publishing again", async () => {
    const { fixture, project, client, ghCalls } = await setUp({
      turns: [
        {
          steps: [
            ...commit("README.md", "# Better fixture\n", "docs: improve the README"),
            push,
            createPullRequest,
            { signal: "published" },
            { waitFor: "never" },
          ],
        },
      ],
    });
    const { taskId } = (await client.call("start_task", writeTask(project))).data;
    await waitFor(() => fixture.signalled("published") || undefined, 15_000);
    await fixture.killService();

    const reconnected = await fixture.connect();
    const recovered = await waitFor(async () => {
      const status = (await reconnected.call("task_status", { project, taskId })).data;
      return status.executions[0].detail?.publication ? status.executions[0] : undefined;
    }, 15_000);
    expect(recovered).toMatchObject({
      status: "interrupted",
      reason: "service_restarted",
      detail: {
        recovery: { process: "ended" },
        workspace: { commitCount: 1, changedFileCount: 1 },
        publication: { pushed: true, pullRequest: { number: 1, state: "OPEN" } },
      },
    });
    expect(recovered.detail.workspace.commits).toBeUndefined();
    const result = await reconnected.call("task_result", {
      project,
      taskId,
      executionId: recovered.executionId,
    });
    expect(result.data).toMatchObject({
      result: null,
      workspace: {
        commits: [{ subject: "docs: improve the README" }],
        changedFiles: ["README.md"],
      },
    });
    const cleanup = await reconnected.call("cleanup_task", {
      project,
      taskId,
      scope: "worktree",
      dryRun: true,
    });
    expect(cleanup.data.outcome).toBe("planned");
    expect(creates(ghCalls())).toHaveLength(1);
    expect(fixture.launches()).toHaveLength(1);
  });

  it("report an unavailable GitHub CLI without copying its error text", async () => {
    const { fixture, project, client } = await setUp(
      {
        turns: [
          {
            steps: [
              ...commit("README.md", "# Better fixture\n", "docs: improve the README"),
              push,
              finished("Pushed; gh failed.", ["gh pr create failed."]),
            ],
          },
        ],
      },
      { pullRequests: [], failWith: "HTTP 401: token tok-GHSECRET rejected" },
    );
    const { taskId } = await run(client, writeTask(project));
    const read = await client.call("task_result", { project, taskId });
    expect(read.data.result.publication).toMatchObject({ pushed: true, pullRequest: null });
    expect(read.data.result.publication.concerns.map((c: { code: string }) => c.code)).toEqual([
      "github_unavailable",
    ]);
    expect(read.text).not.toContain("GHSECRET");
    expect(fixture.serviceLog()).not.toContain("GHSECRET");
  });

  it("leave writing tasks without publish unpublished, as before", async () => {
    const { fixture, project, origin, client, ghCalls } = await setUp({
      turns: [
        {
          steps: [
            ...commit("README.md", "# Better fixture\n", "docs: improve the README"),
            finished("Committed."),
          ],
        },
      ],
    });
    const { publish: _publish, ...unpublished } = writeTask(project);
    const { taskId } = await run(client, unpublished);

    const { result } = (await client.call("task_result", { project, taskId })).data;
    expect(result.publication).toBeUndefined();
    expect(
      (await client.call("task_status", { project, taskId })).data.publication,
    ).toBeUndefined();
    expect(fixture.guidance()[0]!).toContain("Do not push or open pull requests");
    expect(git(origin, "for-each-ref", "--format=%(refname:short)", "refs/heads")).toBe("main");
    expect(ghCalls()).toEqual([]);

    const readOnly = await client.call("start_task", {
      ...unpublished,
      requestKey: "read-only",
      mode: "read-only",
      publish: "pull_request",
    });
    expect(readOnly.isError).toBe(true);
    expect(readOnly.text).toContain("apply only to writing tasks");
  });
});
