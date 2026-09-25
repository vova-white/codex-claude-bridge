import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { Step } from "../fixtures/fake-claude.ts";
import {
  BridgeFixture,
  isAlive,
  waitFor,
  type BridgeClient,
  type BridgeOptions,
} from "../support/bridge.ts";

const fixtures: BridgeFixture[] = [];

function bridge(options?: BridgeOptions): BridgeFixture {
  const fixture = new BridgeFixture(options);
  fixtures.push(fixture);
  return fixture;
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

const finished = (summary: string): Step => ({
  result: {
    text: summary,
    structured: { summary, evidence: ["checked README.md"], failures: [], remainingWork: [] },
  },
});

function assignment(project: string, overrides: Record<string, unknown> = {}) {
  return {
    project,
    requestKey: "review-1",
    assignment: "Summarize the README.",
    context: "The README was added in the first commit.",
    expectedResult: "A one-line summary.",
    ...overrides,
  };
}

async function start(client: BridgeClient, args: Record<string, unknown>) {
  const result = await client.call("start_task", args);
  expect(result.isError, result.text).toBe(false);
  return result.data;
}

async function statusWhen(
  client: BridgeClient,
  project: string,
  taskId: string,
  accept: (status: any) => boolean,
) {
  return waitFor(async () => {
    const status = (await client.call("task_status", { project, taskId })).data;
    return accept(status) ? status : undefined;
  });
}

const terminal = (status: any) => ["completed", "failed", "interrupted"].includes(status.status);

describe("read-only delegated tasks", () => {
  it("runs the supplied brief read-only on the shared checkout and keeps its result", async () => {
    const fixture = bridge({ scenario: { turns: [{ steps: [finished("A fixture README.")] }] } });
    const project = fixture.createRepository();
    const client = await fixture.connect();

    const started = await start(client, assignment(project, { model: "sonnet", effort: "low" }));
    expect(started).toMatchObject({ created: true });
    expect(started.taskId).not.toBe(started.executionId);

    const status = await statusWhen(client, project, started.taskId, terminal);
    expect(status).toMatchObject({ status: "completed", mode: "read-only" });
    expect(status.sessionId).toEqual(expect.any(String));

    const first = await client.call("task_result", { project, taskId: started.taskId });
    expect(first.data).toMatchObject({
      executionId: started.executionId,
      status: "completed",
      result: {
        summary: "A fixture README.",
        evidence: ["checked README.md"],
        failures: [],
        remainingWork: [],
        workspace: { kind: "shared-checkout", path: project, readOnly: true, modifiedFiles: [] },
      },
    });
    expect((await client.call("task_result", { project, taskId: started.taskId })).data).toEqual(
      first.data,
    );

    const [prompt] = fixture.prompts();
    expect(fixture.prompts()).toHaveLength(1);
    expect(prompt).toContain("Summarize the README.");
    expect(prompt).toContain("The README was added in the first commit.");
    expect(prompt).toContain("A one-line summary.");
    const [launch] = fixture.launches();
    expect(launch?.cwd).toBe(project);
    const args = launch!.args.join(" ");
    expect(args).toContain("--model sonnet");
    for (const tool of ["Edit", "Write", "NotebookEdit", "Agent"]) expect(args).toContain(tool);
  });

  it("returns the same task when a start response is lost, and rejects conflicting reuse", async () => {
    const fixture = bridge({
      scenario: { turns: [{ steps: [{ waitFor: "go" }, finished("Summarized.")] }] },
    });
    const project = fixture.createRepository();
    const first = await fixture.connect();
    // The caller gives up on the call: the task is accepted and launched, but the response is never read.
    void first.call("start_task", assignment(project)).catch(() => {});
    await waitFor(() => fixture.launches().length === 1 || undefined);
    await first.close();

    const second = await fixture.connect();
    const retried = await start(second, assignment(project));
    expect(retried).toMatchObject({ created: false });
    const again = await start(second, assignment(project));
    expect(again).toEqual(retried);
    const conflict = await second.call(
      "start_task",
      assignment(project, { assignment: "Something else." }),
    );
    expect(conflict.isError).toBe(true);
    expect(conflict.text).toContain("review-1");

    fixture.release("go");
    await statusWhen(second, project, retried.taskId, terminal);
    expect(fixture.prompts()).toHaveLength(1);
    expect(fixture.launches()).toHaveLength(1);
  });

  it("persists accepted intent before Claude Code answers, and keeps it after the service dies", async () => {
    const fixture = bridge({ scenario: { initializeWaitFor: "never" } });
    const project = fixture.createRepository();
    const client = await fixture.connect();
    const { taskId } = await start(client, assignment(project));
    await waitFor(() => fixture.launches().length === 1 || undefined);

    const pid = fixture.servicePid()!;
    process.kill(pid, "SIGKILL");
    await waitFor(() => !isAlive(pid) || undefined);
    const reconnected = await fixture.connect();
    const status = (await reconnected.call("task_status", { project, taskId })).data;
    expect(status).toMatchObject({
      status: "interrupted",
      request: { assignment: "Summarize the README.", expectedResult: "A one-line summary." },
    });
    expect(fixture.prompts()).toEqual([]);
  });

  it("creates one task for concurrent submissions of the same request", async () => {
    const fixture = bridge();
    const project = fixture.createRepository();
    const clients = await Promise.all([fixture.connect(), fixture.connect()]);
    const results = await Promise.all(
      [...clients, ...clients].map((client) => start(client, assignment(project))),
    );

    expect(new Set(results.map((result) => result.taskId)).size).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    await statusWhen(clients[0]!, project, results[0].taskId, terminal);
    expect(fixture.launches()).toHaveLength(1);
  });

  it("keeps working after the MCP client exits and serves the result to the next client", async () => {
    const fixture = bridge({
      scenario: { turns: [{ steps: [{ waitFor: "go" }, finished("Finished offline.")] }] },
    });
    const project = fixture.createRepository();
    const first = await fixture.connect();
    const { taskId } = await start(first, assignment(project));
    await first.close();

    fixture.release("go");
    const second = await fixture.connect();
    const listed = await second.call("list_tasks", { project });
    expect(listed.data.tasks).toEqual([expect.objectContaining({ taskId })]);
    await statusWhen(second, project, taskId, terminal);
    const result = await second.call("task_result", { project, taskId });
    expect(result.data.result.summary).toBe("Finished offline.");
    expect(isAlive(fixture.servicePid()!)).toBe(true);
  });

  it("scopes discovery and results to the logical caller and project", async () => {
    const fixture = bridge();
    const project = fixture.createRepository();
    const other = fixture.createRepository("other");
    const codex = await fixture.connect({ caller: "codex-a" });
    const { taskId } = await start(codex, assignment(project));

    const stranger = await fixture.connect({ caller: "codex-b" });
    expect((await stranger.call("list_tasks", { project })).data.tasks).toEqual([]);
    expect((await stranger.call("task_status", { project, taskId })).isError).toBe(true);
    expect((await codex.call("task_result", { project: other, taskId })).isError).toBe(true);
    expect((await codex.call("list_tasks", { project })).data.tasks).toHaveLength(1);
  });

  it("keeps configured credentials out of task results", async () => {
    const fixture = bridge({
      config: {
        mcpServers: {
          github: { command: "github-mcp", env: { TOKEN: "tok-RESULTSECRET" } },
          tracker: { type: "http", url: "https://tracker.invalid/mcp?key=url%2fRESULT%20KEY" },
        },
      },
      scenario: {
        turns: [
          {
            steps: [
              {
                result: {
                  structured: {
                    summary: "The token is tok-RESULTSECRET; see https://docs.invalid/a?page=2.",
                    evidence: [
                      "env TOKEN=tok-RESULTSECRET",
                      "called https://tracker.invalid/mcp?key=url%2FRESULT+KEY&page=2",
                    ],
                    failures: [],
                    remainingWork: [],
                  },
                },
              },
            ],
          },
        ],
      },
    });
    const project = fixture.createRepository();
    const client = await fixture.connect();
    const { taskId } = await start(client, assignment(project));
    await statusWhen(client, project, taskId, terminal);

    const result = await client.call("task_result", { project, taskId });
    expect(result.data.result.summary).toBe(
      "The token is [REDACTED]; see https://docs.invalid/a?page=2.",
    );
    expect(result.data.result.evidence[1]).toBe(
      "called https://tracker.invalid/mcp?key=[REDACTED]&page=2",
    );
    expect(result.text).not.toMatch(/RESULTSECRET|RESULT\+KEY/);
  });

  it("reports a staged change even when the working file is restored", async () => {
    const fixture = bridge({
      scenario: {
        turns: [
          {
            steps: [
              { writeFile: { path: "README.md", content: "staged by the task\n" } },
              { exec: ["git", "add", "README.md"] },
              { writeFile: { path: "README.md", content: "working copy\n" } },
              finished("Done."),
            ],
          },
        ],
      },
    });
    const project = fixture.createRepository();
    // The parent already has a staged and a different unstaged version.
    writeFileSync(join(project, "README.md"), "staged by the parent\n");
    execFileSync("git", ["add", "README.md"], { cwd: project });
    writeFileSync(join(project, "README.md"), "working copy\n");
    const client = await fixture.connect();
    const { taskId } = await start(client, assignment(project));
    await statusWhen(client, project, taskId, terminal);

    const { result } = (await client.call("task_result", { project, taskId })).data;
    expect(result.workspace.modifiedFiles).toEqual(["README.md"]);
  });

  it("detects edits to modified files next to a nested repository", async () => {
    const fixture = bridge({
      scenario: {
        turns: [
          {
            steps: [
              { writeFile: { path: "README.md", content: "edited by the task\n" } },
              finished("Done."),
            ],
          },
        ],
      },
    });
    const project = fixture.createRepository();
    // An untracked nested repository shows as a directory in git status.
    fixture.createRepository("repo/nested");
    writeFileSync(join(project, "README.md"), "edited by the parent\n");
    const client = await fixture.connect();
    const { taskId } = await start(client, assignment(project));
    await statusWhen(client, project, taskId, terminal);

    const { result } = (await client.call("task_result", { project, taskId })).data;
    expect(result.workspace.modifiedFiles).toEqual(["README.md"]);
  });

  it("reports checkout changes when the execution fails, without file names in the message", async () => {
    const fixture = bridge({
      config: {
        mcpServers: { github: { command: "github-mcp", env: { TOKEN: "tok-FILESECRET" } } },
      },
      scenario: {
        turns: [
          {
            steps: [
              { writeFile: { path: "notes-tok-FILESECRET.txt", content: "x" } },
              { exit: { code: 1 } },
            ],
          },
        ],
      },
    });
    const project = fixture.createRepository();
    const client = await fixture.connect();
    const { taskId } = await start(client, assignment(project));

    const status = await statusWhen(client, project, taskId, terminal);
    expect(status).toMatchObject({
      status: "failed",
      detail: { modifiedFiles: ["notes-[REDACTED].txt"] },
    });
    expect(status.error.message).toContain("changed 1 file");
    expect(JSON.stringify(status.error)).not.toContain("notes-");
    expect(JSON.stringify(status)).not.toContain("FILESECRET");
  });

  it("never reports a session ID Claude Code sends in an unrecognized form", async () => {
    const fixture = bridge({
      scenario: { sessionId: "LEAK-MARKER-session", turns: [{ steps: [{ exit: { code: 3 } }] }] },
    });
    const project = fixture.createRepository();
    const client = await fixture.connect();
    const { taskId } = await start(client, assignment(project));

    const status = await statusWhen(client, project, taskId, terminal);
    expect(status).toMatchObject({ status: "failed", reason: "provider_error" });
    expect(status.sessionId).toBeUndefined();
    expect(status.error.action).toContain("the task's session");
    expect(JSON.stringify(status)).not.toContain("LEAK-MARKER");
  });

  it("reports files a read-only task changed in the shared checkout", async () => {
    const fixture = bridge({
      scenario: {
        turns: [{ steps: [{ writeFile: { path: "notes.txt", content: "x" } }, finished("Done.")] }],
      },
    });
    const project = fixture.createRepository();
    const client = await fixture.connect();
    const { taskId } = await start(client, assignment(project));
    await statusWhen(client, project, taskId, terminal);

    const { result } = (await client.call("task_result", { project, taskId })).data;
    expect(result.workspace.modifiedFiles).toEqual(["notes.txt"]);
    expect(result.failures).toEqual([expect.stringContaining("notes.txt")]);
  });

  it("does not send the brief without a verified subscription login", async () => {
    const fixture = bridge({
      scenario: { account: { apiKeySource: "ANTHROPIC_API_KEY", apiProvider: "firstParty" } },
    });
    const project = fixture.createRepository();
    const client = await fixture.connect();
    const { taskId } = await start(client, assignment(project));

    const status = await statusWhen(client, project, taskId, terminal);
    expect(status).toMatchObject({ status: "failed", reason: "authentication" });
    expect(status.error.action).toContain("ANTHROPIC_API_KEY");
    expect(status.error.action).not.toContain("/resume");
    expect(fixture.prompts()).toEqual([]);
  });

  it("rejects a model Claude Code does not offer before sending the brief", async () => {
    const fixture = bridge();
    const project = fixture.createRepository();
    const client = await fixture.connect();
    const { taskId } = await start(client, assignment(project, { model: "gpt-imaginary" }));

    const status = await statusWhen(client, project, taskId, terminal);
    expect(status).toMatchObject({ status: "failed", reason: "invalid_request" });
    expect(status.error.message).toContain("gpt-imaginary");
    // Model values come from Claude Code; readiness reports them instead.
    expect(status.error.message).not.toContain("sonnet");
    expect(status.error.action).toContain("readiness");
    expect(fixture.prompts()).toEqual([]);
  });

  // Text Claude Code, the SDK, or an MCP server might produce, quoting configured credentials.
  const trackerUrl = "https://user:url-password-1@tracker.invalid/mcp?key=red%20blue";
  const leaked = `LEAK-MARKER Bearer tok-FAILSECRET at ${trackerUrl} (red+blue)`;
  it.each<{
    name: string;
    steps: Step[];
    reason: string;
    category: string;
    action: string;
    resets?: string;
    detail?: object;
  }>([
    {
      name: "an authentication failure",
      steps: [
        { assistantError: "authentication_failed", text: leaked },
        { result: { isError: true, text: leaked } },
      ],
      reason: "authentication",
      category: "authentication_failed",
      action: "/login",
    },
    {
      name: "an exhausted subscription limit",
      steps: [
        { rateLimit: { status: "rejected", resetsAt: 1_900_000_000 } },
        { assistantError: "rate_limit", text: leaked },
        { result: { isError: true, text: leaked } },
      ],
      reason: "subscription_limit",
      category: "rate_limit",
      resets: "2030-03-17T17:46:40.000Z",
      action: "new request key",
      detail: { resetsAt: 1_900_000_000 },
    },
    {
      name: "a provider error",
      steps: [
        { result: { isError: true, subtype: "error_during_execution", errors: [leaked, leaked] } },
      ],
      reason: "provider_error",
      category: "error_during_execution",
      action: "/resume",
    },
    {
      name: "a crashed Claude Code process",
      steps: [{ exit: { code: 3, stderr: leaked } }],
      reason: "provider_error",
      category: "exited with code 3",
      action: "/resume",
    },
  ])(
    "reports $name as a failed execution without Claude Code's text",
    async ({ steps, reason, category, action, resets, detail }) => {
      const fixture = bridge({
        config: {
          mcpServers: {
            tracker: {
              type: "http",
              url: trackerUrl,
              headers: { Authorization: "Bearer tok-FAILSECRET" },
            },
          },
        },
        scenario: { turns: [{ steps }] },
      });
      const project = fixture.createRepository();
      const client = await fixture.connect();
      const { taskId } = await start(client, assignment(project));

      const status = await statusWhen(client, project, taskId, terminal);
      expect(status).toMatchObject({ status: "failed", reason, ...(detail ? { detail } : {}) });
      expect(status.error.message).toContain(reason);
      expect(status.error.message).toContain(category);
      if (resets) expect(status.error.message).toContain(resets);
      expect(status.error.action).toContain(action);
      // Claude Code started the session, so every action shows where to read its full output.
      expect(status.error.action).toContain(`/resume ${status.sessionId}`);
      expect(status.error.action).toContain(project);
      const result = await client.call("task_result", { project, taskId });
      expect(result.data).toMatchObject({ status: "failed", reason, result: null });
      for (const text of [
        "LEAK-MARKER",
        "FAILSECRET",
        "url-password-1",
        "red+blue",
        "red%20blue",
      ]) {
        expect(JSON.stringify(status)).not.toContain(text);
        expect(result.text).not.toContain(text);
      }
    },
  );

  it("shows a running task waiting for subscription capacity", async () => {
    const fixture = bridge({
      scenario: {
        turns: [
          {
            steps: [
              { rateLimit: { status: "rejected", resetsAt: 1_900_000_000 } },
              { waitFor: "go" },
              { rateLimit: { status: "allowed" } },
              finished("Done after waiting."),
            ],
          },
        ],
      },
    });
    const project = fixture.createRepository();
    const client = await fixture.connect();
    const { taskId } = await start(client, assignment(project));

    const waiting = await statusWhen(
      client,
      project,
      taskId,
      (status) => status.reason === "waiting_for_capacity",
    );
    expect(waiting).toMatchObject({ status: "running", detail: { resetsAt: 1_900_000_000 } });
    fixture.release("go");
    const done = await statusWhen(client, project, taskId, terminal);
    expect(done.status).toBe("completed");
    expect(done.reason).toBeUndefined();
  });

  it("reports work as interrupted after the service dies instead of running", async () => {
    const fixture = bridge({ scenario: { turns: [{ steps: [{ waitFor: "never" }] }] } });
    const project = fixture.createRepository();
    const client = await fixture.connect();
    const { taskId } = await start(client, assignment(project));
    await waitFor(() => fixture.prompts().length === 1 || undefined);

    const pid = fixture.servicePid()!;
    process.kill(pid, "SIGKILL");
    await waitFor(() => !isAlive(pid) || undefined);
    const reconnected = await fixture.connect();
    const status = (await reconnected.call("task_status", { project, taskId })).data;
    expect(status).toMatchObject({ status: "interrupted", reason: "service_restarted" });
  });
});
