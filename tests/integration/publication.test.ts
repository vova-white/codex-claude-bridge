import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { Scenario, Step } from "../fixtures/fake-claude.ts";
import type { FakeGitHub } from "../fixtures/fake-gh.ts";
import { BridgeFixture, type BridgeClient } from "../support/bridge.ts";

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
async function setUp(scenario: Scenario, github: FakeGitHub = { pullRequests: [] }) {
  const bin = mkdtempSync(join(tmpdir(), "bridge-gh-"));
  directories.push(bin);
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/sh\nFAKE_GH_DIR='${bin}' exec '${process.execPath}' '${fakeGh}' "$@"\n`,
    { mode: 0o755 },
  );
  writeFileSync(join(bin, "gh-state.json"), JSON.stringify(github));
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
  return { fixture, project, origin, client, ghCalls };
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
    expect(status.error.publication).toMatchObject({
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
        message: expect.stringContaining("exist only in the task worktree"),
        action: expect.stringContaining(`git -C ${workspace.path} push origin ${workspace.branch}`),
      },
    ]);
    expect(git(workspace.path, "log", "-1", "--format=%s")).toBe("docs: improve the README");
    expect(readFileSync(join(workspace.path, "README.md"), "utf8")).toBe("# Better fixture\n");
    expect(git(origin, "for-each-ref", "--format=%(refname:short)", "refs/heads")).toBe("main");
    expect(ghCalls()).toEqual([]);
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
