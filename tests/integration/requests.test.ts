import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { BridgeOptions, BridgeClient } from "../support/bridge.ts";
import type { Step } from "../fixtures/fake-claude.ts";
import { BridgeFixture, isAlive, waitFor } from "../support/bridge.ts";

const fixtures: BridgeFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

const finished = (summary: string): Step => ({
  result: { text: summary, structured: { summary, evidence: [], failures: [], remainingWork: [] } },
});

const question = {
  questions: [
    {
      question: "Which branch should I review?",
      header: "Branch",
      multiSelect: false,
      options: [
        { label: "main", description: "The default branch" },
        { label: "develop", description: "The integration branch" },
      ],
    },
  ],
};

const trackerCall: Step = {
  canUseTool: {
    name: "mcp__tracker__create_issue",
    input: { title: "Found a bug" },
    mcpServer: { name: "tracker", source: "dynamic" },
  },
};

const trackerConfig = { mcpServers: { tracker: { command: "tracker-mcp" } } };

async function startTask(steps: Step[], options: BridgeOptions = {}) {
  const fixture = new BridgeFixture({
    ...options,
    scenario: { ...options.scenario, turns: [{ steps }] },
  });
  fixtures.push(fixture);
  const project = fixture.createRepository();
  const client = await fixture.connect();
  const started = await client.call("start_task", {
    project,
    requestKey: "task-1",
    assignment: "Review the README.",
    expectedResult: "Findings.",
  });
  expect(started.isError, started.text).toBe(false);
  const taskId: string = started.data.taskId;
  const executionId: string = started.data.executionId;
  return { fixture, project, client, taskId, executionId };
}

/** Waits until the task has a live request and returns it as task_status shows it. */
async function pendingRequest(client: BridgeClient, project: string, taskId: string) {
  return waitFor(async () => {
    const status = (await client.call("task_status", { project, taskId })).data;
    return status.requests?.find((request: { live: boolean }) => request.live);
  });
}

async function events(client: BridgeClient, project: string, taskId: string) {
  const output = (await client.call("read_output", { project, taskId, limit: 200 })).data;
  return output.events.map((event: { text: string }) => event.text);
}

/** Asserts that a request is expired, shown as not answerable, and refuses a late answer. */
async function expectExpired(
  client: BridgeClient,
  project: string,
  taskId: string,
  requestId: string,
) {
  const status = (await client.call("task_status", { project, taskId })).data;
  expect(status.requests).toMatchObject([{ requestId, state: "expired", live: false }]);
  expect(status.requests[0]).not.toHaveProperty("responseShape");
  const late = await client.call("respond_to_request", {
    project,
    taskId,
    requestId,
    response: { decision: "allow" },
  });
  expect(late.isError).toBe(true);
  expect(late.text).toContain("no longer running; send a follow-up instead");
  return status;
}

describe("child questions", () => {
  it("surface the question and continue the turn with the answer", async () => {
    const { client, project, taskId, executionId } = await startTask([
      { canUseTool: { name: "AskUserQuestion", input: question } },
      finished("Reviewed main."),
    ]);

    const request = await pendingRequest(client, project, taskId);
    expect(request).toMatchObject({
      executionId,
      kind: "question",
      toolName: "AskUserQuestion",
      state: "pending",
      live: true,
      question: { questions: [{ question: "Which branch should I review?" }] },
    });
    expect(request.requestId).toMatch(/^req_/);
    expect(request.sessionId).toBeTruthy();
    expect(request.responseShape).toHaveProperty("answers");
    const status = (await client.call("task_status", { project, taskId })).data;
    expect(status).toMatchObject({
      status: "running",
      reason: "needs_input",
      detail: { requestId: request.requestId },
    });

    const answered = await client.call("respond_to_request", {
      project,
      taskId,
      requestId: request.requestId,
      response: { answers: { "Which branch should I review?": "develop" } },
    });
    expect(answered.isError, answered.text).toBe(false);
    const done = await client.call("wait_task", { project, taskId, timeoutSeconds: 30 });
    expect(done.data.status).toBe("completed");
    expect(await events(client, project, taskId)).toContain('AskUserQuestion answered ["develop"]');
    const after = (await client.call("task_status", { project, taskId })).data;
    expect(after.requests).toMatchObject([
      { requestId: request.requestId, state: "answered", live: false },
    ]);
  });
  it("give identical questions distinct answer keys and refuse different answers to them", async () => {
    const { client, project, taskId } = await startTask([
      {
        canUseTool: {
          name: "AskUserQuestion",
          input: {
            questions: [
              { ...question.questions[0], question: "Revoke the token?" },
              { ...question.questions[0], question: "Revoke the token?" },
              // Collides with the key the second question gets.
              { ...question.questions[0], question: "Revoke the token? (question 2)" },
            ],
          },
        },
      },
      finished("Done."),
    ]);
    const request = await pendingRequest(client, project, taskId);
    const keys = Object.keys(request.responseShape.answers);
    expect(keys).toEqual([
      "Revoke the token?",
      "Revoke the token? (question 2)",
      "Revoke the token? (question 2) (question 3)",
    ]);

    // Claude Code takes one answer per question text, so identical questions need the same one.
    const respond = (answers: string[]) =>
      client.call("respond_to_request", {
        project,
        taskId,
        requestId: request.requestId,
        response: { answers: Object.fromEntries(keys.map((key, index) => [key, answers[index]])) },
      });
    const conflicting = await respond(["yes", "no", "later"]);
    expect(conflicting.isError).toBe(true);
    expect(conflicting.text).toContain("give both the same answer");
    const answered = await respond(["yes", "yes", "later"]);
    expect(answered.isError, answered.text).toBe(false);
    await client.call("wait_task", { project, taskId, timeoutSeconds: 30 });
    expect(await events(client, project, taskId)).toContain(
      'AskUserQuestion answered ["yes","yes","later"]',
    );
  });

  it("can be answered by a new MCP client after the first disconnects", async () => {
    const { fixture, client, project, taskId } = await startTask([
      { canUseTool: { name: "AskUserQuestion", input: question } },
      finished("Done."),
    ]);
    const { requestId } = await pendingRequest(client, project, taskId);
    await client.close();

    const reconnected = await fixture.connect();
    const answered = await reconnected.call("respond_to_request", {
      project,
      taskId,
      requestId,
      response: { answers: { "Which branch should I review?": "main" } },
    });
    expect(answered.isError, answered.text).toBe(false);
    const done = await reconnected.call("wait_task", { project, taskId, timeoutSeconds: 30 });
    expect(done.data.status).toBe("completed");
    expect(await events(reconnected, project, taskId)).toContain(
      'AskUserQuestion answered ["main"]',
    );
  });
});

describe("permission requests", () => {
  it.each([
    {
      decision: "allow",
      message: undefined,
      said: 'mcp__tracker__create_issue allowed {"title":"Found a bug"}',
    },
    {
      decision: "deny",
      message: "Do not file issues.",
      said: "mcp__tracker__create_issue denied Do not file issues.",
    },
  ])(
    "ask before a configured MCP tool runs and pass on the $decision decision",
    async ({ decision, message, said }) => {
      const { client, project, taskId } = await startTask([trackerCall, finished("Done.")], {
        config: trackerConfig,
      });

      const request = await pendingRequest(client, project, taskId);
      expect(request).toMatchObject({
        kind: "permission",
        toolName: "mcp__tracker__create_issue",
        action: {
          toolName: "mcp__tracker__create_issue",
          mcpServer: "tracker",
          input: { title: "Found a bug" },
        },
        responseShape: { decision: "allow | deny" },
      });
      const response = { decision, ...(message ? { message } : {}) };
      const answered = await client.call("respond_to_request", {
        project,
        taskId,
        requestId: request.requestId,
        response,
      });
      expect(answered.data).toMatchObject({ state: "answered", response, repeated: false });
      await client.call("wait_task", { project, taskId, timeoutSeconds: 30 });
      expect(await events(client, project, taskId)).toContain(said);
    },
  );

  it("let an autoApprove server and built-in tools run without a request", async () => {
    const { fixture, client, project, taskId } = await startTask(
      [
        {
          canUseTool: {
            name: "mcp__auto__lookup",
            input: { id: 1 },
            mcpServer: { name: "auto", source: "dynamic" },
          },
        },
        { canUseTool: { name: "Bash", input: { command: "git log" } } },
        finished("Done."),
      ],
      {
        config: {
          mcpServers: {
            ...trackerConfig.mcpServers,
            auto: { command: "auto-mcp", autoApprove: true },
          },
        },
      },
    );

    const done = await client.call("wait_task", { project, taskId, timeoutSeconds: 30 });
    expect(done.data.status).toBe("completed");
    const said = await events(client, project, taskId);
    expect(said).toContain('mcp__auto__lookup allowed {"id":1}');
    expect(said).toContain('Bash allowed {"command":"git log"}');
    expect((await client.call("task_status", { project, taskId })).data.requests).toEqual([]);
    // Claude Code receives the servers in its own format, without the bridge's setting.
    const args = fixture.launches()[0]!.args;
    const mcpConfig = JSON.parse(readFileSync(args[args.indexOf("--mcp-config") + 1]!, "utf8"));
    expect(mcpConfig.mcpServers.auto).toEqual({ command: "auto-mcp" });
  });
});

describe("responses", () => {
  it("apply a repeated identical answer once and reject a conflicting one", async () => {
    const { fixture, client, project, taskId } = await startTask(
      [trackerCall, { waitFor: "go" }, finished("Done.")],
      { config: trackerConfig },
    );
    const { requestId } = await pendingRequest(client, project, taskId);
    const respond = (response: object) =>
      client.call("respond_to_request", { project, taskId, requestId, response });

    expect((await respond({ decision: "allow" })).data.repeated).toBe(false);
    const repeated = await respond({ decision: "allow" });
    expect(repeated.data).toMatchObject({
      state: "answered",
      response: { decision: "allow" },
      repeated: true,
    });
    const conflict = await respond({ decision: "deny" });
    expect(conflict.isError).toBe(true);
    expect(conflict.text).toContain("already answered");
    expect(conflict.text).not.toContain("allow");
    const wrongShape = await respond({ answers: { "Which?": "main" } });
    expect(wrongShape.isError).toBe(true);

    fixture.release("go");
    await client.call("wait_task", { project, taskId, timeoutSeconds: 30 });
    const said = await events(client, project, taskId);
    expect(said.filter((text: string) => text.startsWith("mcp__tracker__create_issue"))).toEqual([
      'mcp__tracker__create_issue allowed {"title":"Found a bug"}',
    ]);
  });

  it("end a wait when Claude starts waiting for input", async () => {
    const { client, project, taskId, executionId } = await startTask([
      { canUseTool: { name: "AskUserQuestion", input: question } },
      finished("Done."),
    ]);
    const waited = await client.call("wait_task", { project, taskId, timeoutSeconds: 30 });
    expect(waited.data).toMatchObject({
      executionId,
      status: "running",
      reason: "needs_input",
      timedOut: false,
    });
    expect(waited.data.detail.requestId).toMatch(/^req_/);

    const began = Date.now();
    const again = await client.call("wait_task", { project, taskId, timeoutSeconds: 30 });
    expect(again.data).toMatchObject({ reason: "needs_input", timedOut: false });
    expect(Date.now() - began).toBeLessThan(5_000);
  });
});

describe("waiting in the start call", () => {
  it("returns as soon as Claude asks a question", async () => {
    const fixture = new BridgeFixture({
      scenario: {
        turns: [{ steps: [{ canUseTool: { name: "AskUserQuestion", input: question } }] }],
      },
    });
    fixtures.push(fixture);
    const project = fixture.createRepository();
    const client = await fixture.connect();

    const began = Date.now();
    const started = await client.call("start_task", {
      project,
      requestKey: "task-1",
      assignment: "Review the README.",
      expectedResult: "Findings.",
      waitSeconds: 30,
    });
    expect(started.data).toMatchObject({
      created: true,
      status: "running",
      reason: "needs_input",
      timedOut: false,
    });
    expect(started.data.detail.requestId).toMatch(/^req_/);
    expect(Date.now() - began).toBeLessThan(15_000);
  });
});

describe("stale requests", () => {
  it("expire when Claude Code exits while the request is pending", async () => {
    const { fixture, client, project, taskId } = await startTask(
      [
        { canUseTool: { ...trackerCall.canUseTool, await: false } },
        { waitFor: "crash" },
        { exit: { code: 1 } },
      ],
      { config: trackerConfig },
    );
    const { requestId } = await pendingRequest(client, project, taskId);
    fixture.release("crash");
    // wait_task returns at once while the request is pending, so watch the status instead.
    const done = await waitFor(async () => {
      const status = (await client.call("task_status", { project, taskId })).data;
      return status.terminal ? status : undefined;
    });
    expect(done).toMatchObject({ status: "failed", reason: "provider_error" });
    await expectExpired(client, project, taskId, requestId);
  });

  it("expire when the bridge service restarts", async () => {
    const { fixture, client, project, taskId } = await startTask([trackerCall, finished("Done.")], {
      config: trackerConfig,
    });
    const { requestId } = await pendingRequest(client, project, taskId);
    const pid = fixture.servicePid()!;
    process.kill(pid, "SIGKILL");
    await waitFor(() => !isAlive(pid) || undefined);

    const reconnected = await fixture.connect();
    const status = await expectExpired(reconnected, project, taskId, requestId);
    expect(status.status).toBe("interrupted");
  });

  it("expire and release Claude when the task is cancelled", async () => {
    const { fixture, client, project, taskId } = await startTask([trackerCall, finished("Done.")], {
      config: trackerConfig,
    });
    const { requestId } = await pendingRequest(client, project, taskId);
    const cancelled = await client.call("cancel_task", { project, taskId });
    expect(cancelled.data).toMatchObject({ cancellation: "confirmed" });
    const pids = fixture.launches().map((launch) => launch.pid);
    expect(pids.every((pid) => !isAlive(pid))).toBe(true);
    await expectExpired(client, project, taskId, requestId);
  });
});

describe("requests with nested agents", () => {
  const nestedRequest: Step[] = [
    { nestedStart: { id: "docs", description: "Review the docs", background: true } },
    // A nested agent's tool call waits for approval while the executor's turn ends.
    { canUseTool: { ...trackerCall.canUseTool, await: false } },
    finished("Started a background review of the docs."),
  ];

  it("keep needs_input over waiting for children, then wait for children after the answer", async () => {
    const { fixture, client, project, taskId, executionId } = await startTask(
      [
        ...nestedRequest,
        { waitFor: "child" },
        { nestedEnd: { id: "docs", status: "completed" } },
        finished("Done."),
      ],
      { config: trackerConfig },
    );
    const { requestId } = await pendingRequest(client, project, taskId);
    await waitFor(async () =>
      (await events(client, project, taskId)).some((text: string) =>
        text.startsWith("Claude finished its turn"),
      ),
    );
    const status = (await client.call("task_status", { project, taskId })).data;
    expect(status).toMatchObject({ reason: "needs_input", detail: { requestId } });
    const waited = await client.call("wait_task", { project, taskId, timeoutSeconds: 30 });
    expect(waited.data).toMatchObject({ reason: "needs_input", timedOut: false });

    await client.call("respond_to_request", {
      project,
      taskId,
      requestId,
      response: { decision: "allow" },
    });
    const after = (await client.call("task_status", { project, taskId })).data;
    expect(after).toMatchObject({
      status: "running",
      reason: "waiting_for_children",
      detail: { runningNested: 1 },
    });

    fixture.release("child");
    const done = await client.call("wait_task", {
      project,
      taskId,
      executionId,
      timeoutSeconds: 30,
    });
    expect(done.data.status).toBe("completed");
  });

  it("expire a pending request as soon as cancellation starts, while nested agents stop", async () => {
    const { client, project, taskId } = await startTask(
      [
        { nestedStart: { id: "docs", description: "Review the docs", background: true } },
        trackerCall,
        { waitFor: "never" },
      ],
      // The nested agent never reports stopping, so the bridge waits its grace period.
      { config: trackerConfig, scenario: { ignoreStop: ["docs"] } },
    );
    const { requestId } = await pendingRequest(client, project, taskId);

    const cancelling = client.call("cancel_task", { project, taskId });
    await waitFor(async () => {
      const status = (await client.call("task_status", { project, taskId })).data;
      return status.requests[0].state === "expired" || undefined;
    }, 3_000);
    const late = await client.call("respond_to_request", {
      project,
      taskId,
      requestId,
      response: { decision: "allow" },
    });
    expect(late.isError).toBe(true);
    expect(late.text).toContain("expired");
    await waitFor(async () =>
      (await events(client, project, taskId)).some((text: string) =>
        text.startsWith("mcp__tracker__create_issue denied"),
      ),
    );
    expect((await cancelling).data).toMatchObject({ cancellation: "confirmed" });
  }, 30_000);
});
