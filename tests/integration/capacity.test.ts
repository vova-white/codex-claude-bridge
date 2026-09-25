import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { Scenario, Step } from "../fixtures/fake-claude.ts";
import { BridgeFixture, waitFor, type BridgeClient } from "../support/bridge.ts";

const fixtures: BridgeFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

const finished = (summary: string): Step => ({
  result: {
    text: summary,
    structured: { summary, evidence: [], failures: [], remainingWork: [], checks: [] },
  },
});

function bridge(scenario: Scenario, config: Record<string, unknown> = {}) {
  const fixture = new BridgeFixture({ scenario, config });
  fixtures.push(fixture);
  return { fixture, project: fixture.createRepository() };
}

function task(project: string, requestKey: string, assignment: string, mode = "write") {
  return { project, requestKey, mode, assignment, expectedResult: "The change." };
}

async function start(client: BridgeClient, args: Record<string, unknown>) {
  const started = await client.call("start_task", args);
  expect(started.isError, started.text).toBe(false);
  return started.data;
}

async function status(client: BridgeClient, project: string, taskId: string) {
  return (await client.call("task_status", { project, taskId })).data;
}

async function slots(client: BridgeClient, project: string) {
  return (await client.call("list_tasks", { project })).data.slots;
}

async function finish(client: BridgeClient, project: string, taskId: string) {
  return (await client.call("wait_task", { project, taskId, timeoutSeconds: 30 })).data;
}

const waitingForSlot = (position: number, limit: number) => ({
  status: "queued",
  reason: "waiting_for_slot",
  detail: { position, limit },
  terminal: false,
});

describe("execution slots", () => {
  it("runs at most the configured executions across clients and starts queued ones in order", async () => {
    const blocked = (name: string): Step[] => [
      { signal: `${name}-running` },
      { waitFor: `${name}-go` },
      { writeFile: { path: `${name}.txt`, content: `${name}\n` } },
      finished(`${name} done.`),
    ];
    const { fixture, project } = bridge(
      {
        turns: [
          { match: "alpha", steps: blocked("alpha") },
          { match: "beta", steps: blocked("beta") },
          { match: "gamma", steps: [finished("gamma reviewed.")] },
        ],
      },
      { maxConcurrentExecutions: 1 },
    );
    const [first, second] = await Promise.all([fixture.connect(), fixture.connect()]);

    const alpha = await start(first, task(project, "alpha", "Add alpha."));
    await waitFor(() => fixture.signalled("alpha-running") || undefined);
    const betaArgs = task(project, "beta", "Add beta.");
    const beta = await start(second, betaArgs);
    expect(beta).toMatchObject({ created: true, ...waitingForSlot(1, 1) });
    const gamma = await start(first, task(project, "gamma", "Review gamma.", "read-only"));
    expect(gamma).toMatchObject(waitingForSlot(2, 1));

    expect(await status(first, project, beta.taskId)).toMatchObject(waitingForSlot(1, 1));
    const listed = (await second.call("list_tasks", { project })).data;
    expect(listed.slots).toEqual({ limit: 1, running: 1, queued: 2 });
    expect(
      listed.tasks.map((entry: { status: string; reason?: string }) => [
        entry.status,
        entry.reason,
      ]),
    ).toEqual([
      ["running", undefined],
      ["queued", "waiting_for_slot"],
      ["queued", "waiting_for_slot"],
    ]);

    // Duplicate submissions from either connection return the queued task and take no slot.
    const retries = await Promise.all([
      first.call("start_task", betaArgs),
      second.call("start_task", betaArgs),
    ]);
    for (const retry of retries) {
      expect(retry.data).toMatchObject({ taskId: beta.taskId, created: false, status: "queued" });
    }
    expect(await slots(first, project)).toEqual({ limit: 1, running: 1, queued: 2 });
    expect(fixture.launches()).toHaveLength(1);

    fixture.release("alpha-go");
    await waitFor(() => fixture.signalled("beta-running") || undefined);
    expect((await status(first, project, alpha.taskId)).status).toBe("completed");
    const running = await status(second, project, beta.taskId);
    expect(running).toMatchObject({ status: "running", terminal: false });
    expect(running.reason).toBeUndefined();
    expect(await slots(first, project)).toEqual({ limit: 1, running: 1, queued: 1 });
    const waited = (
      await first.call("wait_task", { project, taskId: gamma.taskId, timeoutSeconds: 0 })
    ).data;
    expect(waited).toMatchObject({ timedOut: true, ...waitingForSlot(1, 1) });

    const events = (
      await second.call("read_output", { project, taskId: beta.taskId })
    ).data.events.map((event: { text: string }) => event.text);
    const queuedAt = events.findIndex((text: string) => text.startsWith("Waiting for a free slot"));
    expect(queuedAt).toBeGreaterThan(-1);
    expect(events.indexOf("Running.")).toBeGreaterThan(queuedAt);

    fixture.release("beta-go");
    expect((await finish(first, project, gamma.taskId)).status).toBe("completed");
    expect((await finish(second, project, beta.taskId)).status).toBe("completed");
    expect(await slots(second, project)).toEqual({ limit: 1, running: 0, queued: 0 });
    expect(fixture.launches()).toHaveLength(3);

    const workspaces = await Promise.all(
      [alpha, beta].map(
        async ({ taskId }) =>
          (await first.call("task_result", { project, taskId })).data.result.workspace,
      ),
    );
    expect(workspaces[0].path).not.toBe(workspaces[1].path);
    expect(workspaces[0].branch).not.toBe(workspaces[1].branch);
    expect(workspaces.map((workspace) => workspace.changedFiles)).toEqual([
      ["alpha.txt"],
      ["beta.txt"],
    ]);
    expect(existsSync(join(workspaces[1].path, "alpha.txt"))).toBe(false);
    expect(existsSync(join(project, "alpha.txt"))).toBe(false);
  }, 30_000);

  it("gives unrelated callers with the same request key separate tasks, worktrees, and branches", async () => {
    const { fixture, project } = bridge({
      turns: [
        {
          steps: [
            { writeFile: { path: "change.txt", content: "c\n" } },
            { waitFor: "go" },
            finished("Changed."),
          ],
        },
      ],
    });
    const [codexA, codexB, codexC] = await Promise.all([
      fixture.connect({ caller: "codex-a" }),
      fixture.connect({ caller: "codex-b" }),
      fixture.connect({ caller: "codex-c" }),
    ]);
    const args = task(project, "same-key", "Add the change file.");
    const [a, b] = await Promise.all([start(codexA, args), start(codexB, args)]);
    expect(a.taskId).not.toBe(b.taskId);
    expect([a.created, b.created]).toEqual([true, true]);

    // The default limit runs both at once and queues a third caller's task.
    await waitFor(() => fixture.launches().length === 2 || undefined);
    const c = await start(codexC, args);
    expect(c).toMatchObject(waitingForSlot(1, 2));
    expect(await slots(codexA, project)).toEqual({ limit: 2, running: 2, queued: 1 });
    expect((await codexA.call("list_tasks", { project })).data.tasks).toEqual([
      expect.objectContaining({ taskId: a.taskId }),
    ]);

    fixture.release("go");
    const clients = [codexA, codexB, codexC];
    const ids = [a, b, c].map(({ taskId }) => taskId);
    const results = await Promise.all(
      clients.map(async (client, index) => {
        expect((await finish(client, project, ids[index]!)).status).toBe("completed");
        return (await client.call("task_result", { project, taskId: ids[index] })).data.result;
      }),
    );
    const workspaces = results.map((result) => result.workspace);
    expect(new Set(workspaces.map((workspace) => workspace.path)).size).toBe(3);
    expect(new Set(workspaces.map((workspace) => workspace.branch)).size).toBe(3);
    for (const workspace of workspaces) {
      expect(workspace.changedFiles).toEqual(["change.txt"]);
    }
    expect(existsSync(join(project, "change.txt"))).toBe(false);
  }, 30_000);

  it("releases slots after failure and cancellation without replacing the failed agent", async () => {
    const { fixture, project } = bridge(
      {
        turns: [
          {
            match: "Fail",
            steps: [
              { waitFor: "fail-go" },
              { rateLimit: { status: "rejected", resetsAt: 1_900_000_000 } },
              { assistantError: "rate_limit", text: "Limit reached" },
              { result: { isError: true, text: "Limit reached" } },
            ],
          },
          { match: "Stop", steps: [{ signal: "stop-running" }, { waitFor: "never" }] },
          { steps: [finished("Done.")] },
        ],
      },
      { maxConcurrentExecutions: 1 },
    );
    const client = await fixture.connect();
    const failing = await start(client, task(project, "a", "Fail on the limit.", "read-only"));
    await waitFor(() => fixture.launches().length === 1 || undefined);
    const stopping = await start(client, task(project, "b", "Stop when asked.", "read-only"));
    const skipped = await start(client, task(project, "c", "Skip this.", "read-only"));
    const last = await start(client, task(project, "d", "Last one.", "read-only"));
    expect(last).toMatchObject(waitingForSlot(3, 1));

    const cancelledQueued = (await client.call("cancel_task", { project, taskId: skipped.taskId }))
      .data;
    expect(cancelledQueued).toMatchObject({ cancellation: "confirmed" });
    expect(await status(client, project, last.taskId)).toMatchObject(waitingForSlot(2, 1));

    fixture.release("fail-go");
    // The rejected rate limit ends one wait as blocked; the failure follows.
    const failed = await waitFor(async () => {
      const current = await status(client, project, failing.taskId);
      return current.terminal ? current : undefined;
    });
    expect(failed).toMatchObject({ status: "failed", reason: "subscription_limit" });
    await waitFor(() => fixture.signalled("stop-running") || undefined);
    expect(await status(client, project, last.taskId)).toMatchObject(waitingForSlot(1, 1));

    const cancelled = (await client.call("cancel_task", { project, taskId: stopping.taskId })).data;
    expect(cancelled.cancellation).toBe("confirmed");
    expect((await finish(client, project, last.taskId)).status).toBe("completed");
    expect(await slots(client, project)).toEqual({ limit: 1, running: 0, queued: 0 });

    const prompts = fixture.prompts();
    expect(prompts).toHaveLength(3);
    expect(prompts.filter((prompt) => prompt.includes("Fail on the limit"))).toHaveLength(1);
    expect(prompts.some((prompt) => prompt.includes("Skip this"))).toBe(false);
  }, 30_000);

  it("counts an execution waiting for subscription capacity against the limit", async () => {
    const { fixture, project } = bridge(
      {
        turns: [
          {
            match: "Wait",
            steps: [
              { rateLimit: { status: "rejected", resetsAt: 1_900_000_000 } },
              { waitFor: "go" },
              { rateLimit: { status: "allowed" } },
              finished("Waited."),
            ],
          },
          { steps: [finished("Done.")] },
        ],
      },
      { maxConcurrentExecutions: 1 },
    );
    const client = await fixture.connect();
    const waiting = await start(client, task(project, "a", "Wait for capacity.", "read-only"));
    expect(await finish(client, project, waiting.taskId)).toMatchObject({
      status: "running",
      reason: "waiting_for_capacity",
      timedOut: false,
    });
    const next = await start(client, task(project, "b", "Next.", "read-only"));
    expect(next).toMatchObject(waitingForSlot(1, 1));
    expect(await slots(client, project)).toEqual({ limit: 1, running: 1, queued: 1 });
    expect(fixture.launches()).toHaveLength(1);

    fixture.release("go");
    expect((await finish(client, project, next.taskId)).status).toBe("completed");
    expect((await status(client, project, waiting.taskId)).status).toBe("completed");
    expect(fixture.launches()).toHaveLength(2);
  }, 30_000);

  it("queues follow-ups for a slot behind executions already waiting", async () => {
    const { fixture, project } = bridge(
      {
        turns: [
          { match: "task-alpha", steps: [{ waitFor: "alpha-go" }, finished("Alpha.")] },
          {
            match: "task-beta",
            steps: [{ signal: "beta-running" }, { waitFor: "beta-go" }, finished("Beta.")],
          },
          { steps: [finished("Done.")] },
        ],
      },
      { maxConcurrentExecutions: 1 },
    );
    const client = await fixture.connect();
    const zero = await start(client, task(project, "zero", "Start zero.", "read-only"));
    expect((await finish(client, project, zero.taskId)).status).toBe("completed");
    const alpha = await start(client, task(project, "alpha", "Run task-alpha.", "read-only"));
    await waitFor(() => fixture.launches().length === 2 || undefined);

    const behind = (
      await client.call("send_followup", {
        project,
        taskId: alpha.taskId,
        requestKey: "more-alpha",
        message: "More on the first.",
      })
    ).data;
    expect(behind).toMatchObject({ delivery: "queued", queuedBehind: alpha.executionId });
    expect(behind.reason).toBeUndefined();
    const beta = await start(client, task(project, "beta", "Run task-beta.", "read-only"));
    expect(beta).toMatchObject(waitingForSlot(1, 1));

    // The follow-up was sent first but joins the line only when its task's execution ends.
    fixture.release("alpha-go");
    await waitFor(() => fixture.signalled("beta-running") || undefined);
    const alphaStatus = await status(client, project, alpha.taskId);
    expect(alphaStatus.executions[1]).toMatchObject(waitingForSlot(1, 1));

    const idle = (
      await client.call("send_followup", {
        project,
        taskId: zero.taskId,
        requestKey: "more-zero",
        message: "More on zero.",
      })
    ).data;
    expect(idle).toMatchObject({ delivery: "queued", ...waitingForSlot(2, 1) });
    expect(idle.queuedBehind).toBeUndefined();
    expect(await slots(client, project)).toEqual({ limit: 1, running: 1, queued: 2 });

    fixture.release("beta-go");
    await client.call("wait_task", {
      project,
      taskId: zero.taskId,
      executionId: idle.executionId,
      timeoutSeconds: 30,
    });
    expect(fixture.prompts().slice(1)).toEqual([
      expect.stringContaining("task-alpha"),
      expect.stringContaining("task-beta"),
      expect.stringContaining("More on the first."),
      expect.stringContaining("More on zero."),
    ]);
  }, 30_000);

  it("applies an edited limit when callers next read task state", async () => {
    const { fixture, project } = bridge(
      { turns: [{ steps: [{ waitFor: "go" }, finished("Done.")] }] },
      { maxConcurrentExecutions: 1 },
    );
    const client = await fixture.connect();
    await start(client, task(project, "a", "First.", "read-only"));
    const second = await start(client, task(project, "b", "Second.", "read-only"));
    expect(second).toMatchObject(waitingForSlot(1, 1));

    const config = join(fixture.stateDir, "config.json");
    const edit = (limit: number) =>
      writeFileSync(
        config,
        JSON.stringify({
          ...JSON.parse(readFileSync(config, "utf8")),
          maxConcurrentExecutions: limit,
        }),
      );
    edit(2);
    expect(await slots(client, project)).toEqual({ limit: 2, running: 1, queued: 0 });
    await waitFor(() => fixture.launches().length === 2 || undefined);
    expect(await slots(client, project)).toEqual({ limit: 2, running: 2, queued: 0 });

    edit(0);
    expect(await slots(client, project)).toEqual({ limit: null, running: 2, queued: 0 });
  }, 30_000);

  it("refuses work when the configured limit is not a positive integer", async () => {
    const { fixture, project } = bridge({}, { maxConcurrentExecutions: 0 });
    const client = await fixture.connect();
    const refused = await client.call("start_task", task(project, "a", "Anything.", "read-only"));
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("maxConcurrentExecutions");
    expect(fixture.launches()).toEqual([]);
  });
});
