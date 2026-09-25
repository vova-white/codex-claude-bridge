import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
    structured: { summary, evidence: [], failures: [], remainingWork: [], checks: [] },
  },
});

const commit: Step = {
  exec: [
    "git",
    "-c",
    "user.name=Child",
    "-c",
    "user.email=child@example.invalid",
    "commit",
    "-qam",
    "docs: change the README",
  ],
};

async function start(client: BridgeClient, args: Record<string, unknown>) {
  const result = await client.call("start_task", {
    requestKey: "task-1",
    assignment: "Review the README.",
    expectedResult: "Findings.",
    ...args,
  });
  expect(result.isError, result.text).toBe(false);
  return result.data as { taskId: string; executionId: string; reason?: string };
}

async function status(client: BridgeClient, project: string, taskId: string) {
  return (await client.call("task_status", { project, taskId })).data;
}

/**
 * Waits until the service has recorded the task's Claude session. The scripted
 * Claude Code signals from its own process, before the service has necessarily
 * read the session it reported, so a crash right after a signal could lose it.
 */
async function sessionRecorded(client: BridgeClient, project: string, taskId: string) {
  await waitFor(async () => (await status(client, project, taskId)).sessionId);
}

async function finish(client: BridgeClient, project: string, taskId: string, executionId: string) {
  const waited = await client.call("wait_task", {
    project,
    taskId,
    executionId,
    timeoutSeconds: 30,
  });
  return waited.data;
}

describe("recovery after a service crash", () => {
  it("keeps a completed result, its task identity, and its dirty worktree", async () => {
    const fixture = bridge({
      scenario: {
        turns: [
          {
            steps: [
              { writeFile: { path: "README.md", content: "# Changed\n" } },
              commit,
              { writeFile: { path: "draft.txt", content: "not committed\n" } },
              finished("Changed the README."),
            ],
          },
        ],
      },
    });
    const project = fixture.createRepository();
    const client = await fixture.connect();
    const { taskId, executionId } = await start(client, { project, mode: "write" });
    expect((await finish(client, project, taskId, executionId)).status).toBe("completed");
    const before = await status(client, project, taskId);
    const result = (await client.call("task_result", { project, taskId })).data;

    await fixture.killService();
    const reconnected = await fixture.connect();

    expect(await status(reconnected, project, taskId)).toEqual(before);
    expect((await reconnected.call("task_result", { project, taskId })).data).toEqual(result);
    expect(readFileSync(join(before.workspace.path, "draft.txt"), "utf8")).toBe("not committed\n");
    expect(fixture.launches()).toHaveLength(1);
  });

  it("stops Claude Code that outlived the service, proven by its PID and start time, and never reruns it", async () => {
    const fixture = bridge({
      scenario: {
        turns: [
          { match: "Continue", steps: [finished("Continued.")] },
          { steps: [{ ignoreTermination: true }, { signal: "working" }, { waitFor: "never" }] },
        ],
      },
    });
    const project = fixture.createRepository();
    const client = await fixture.connect();
    const { taskId, executionId } = await start(client, { project });
    await waitFor(() => fixture.signalled("working") || undefined);
    await sessionRecorded(client, project, taskId);
    const [launch] = fixture.launches();

    await fixture.killService();
    expect(isAlive(launch!.pid)).toBe(true);
    const reconnected = await fixture.connect();

    const recovered = await status(reconnected, project, taskId);
    expect(recovered).toMatchObject({
      status: "interrupted",
      reason: "service_restarted",
      detail: { recovery: { process: "stopped" } },
    });
    await waitFor(() => !isAlive(launch!.pid) || undefined);
    expect(fixture.launches()).toHaveLength(1);

    // Resuming is an explicit follow-up to the same Claude session.
    const sent = await reconnected.call("send_followup", {
      project,
      taskId,
      requestKey: "more-1",
      message: "Continue.",
    });
    expect(sent.data).toMatchObject({
      created: true,
      resumes: { interruptedExecution: executionId, sessionId: recovered.sessionId },
    });
    const outcome = await finish(reconnected, project, taskId, sent.data.executionId);
    expect(outcome.status).toBe("completed");
    const resumed = fixture.launches()[1]!;
    expect(resumed.args).toContain(`--resume=${recovered.sessionId}`);
    expect(fixture.prompts()[1]).toContain("<previous-execution-interrupted>");
  });

  it("starts accepted work that was still waiting for a slot and reports launched work as interrupted", async () => {
    const fixture = bridge({
      config: { maxConcurrentExecutions: 1 },
      scenario: {
        turns: [
          { match: "Second", steps: [finished("Second done.")] },
          { steps: [{ signal: "first-running" }, { waitFor: "never" }] },
        ],
      },
    });
    const project = fixture.createRepository();
    const client = await fixture.connect();
    const first = await start(client, { project, assignment: "First review." });
    await waitFor(() => fixture.signalled("first-running") || undefined);
    const second = await start(client, {
      project,
      requestKey: "task-2",
      assignment: "Second review.",
    });
    expect(second.reason).toBe("waiting_for_slot");

    await fixture.killService();
    const reconnected = await fixture.connect();

    const done = await finish(reconnected, project, second.taskId, second.executionId);
    expect(done.status).toBe("completed");
    expect(await status(reconnected, project, first.taskId)).toMatchObject({
      status: "interrupted",
      detail: { recovery: { process: "ended" } },
    });
    const events = (
      await reconnected.call("read_output", { project, taskId: second.taskId, limit: 200 })
    ).data.events.map((event: { text: string }) => event.text);
    expect(events).toContain(
      "The bridge service restarted before this execution started; it stays queued.",
    );
    expect(fixture.prompts().filter((prompt) => prompt.includes("First review."))).toHaveLength(1);
    expect(fixture.launches()).toHaveLength(2);
  });

  it("keeps work queued before a machine restart uncertain when the service dies during recovery", async () => {
    const fixture = bridge({
      config: { maxConcurrentExecutions: 1 },
      scenario: {
        turns: [
          { match: "Second", steps: [finished("Second done.")] },
          {
            steps: [
              { ignoreTermination: true, signalOnTerm: "terminated" },
              { signal: "first-running" },
              { waitFor: "never" },
            ],
          },
        ],
      },
    });
    const project = fixture.createRepository();
    const client = await fixture.connect();
    const first = await start(client, { project, assignment: "First review." });
    await waitFor(() => fixture.signalled("first-running") || undefined);
    await sessionRecorded(client, project, first.taskId);
    const second = await start(client, {
      project,
      requestKey: "task-2",
      assignment: "Second review.",
    });
    expect(second.reason).toBe("waiting_for_slot");
    await fixture.killService();

    // A machine restart, as the next service sees it: the database last ran in another boot.
    // (The first Claude Code survives only so that recovery has a step to die in.)
    const db = new DatabaseSync(join(fixture.stateDir, "state.db"));
    db.prepare("UPDATE service_state SET value = 'an-earlier-boot' WHERE key = 'boot_id'").run();
    db.close();
    // Started here so its PID is known while it recovers, before it serves anyone.
    const recovering = spawn(process.execPath, [resolve("src/cli.ts"), "service"], {
      env: fixture.env,
      stdio: "ignore",
    });
    await waitFor(() => fixture.signalled("terminated") || undefined);
    process.kill(recovering.pid!, "SIGKILL");
    await waitFor(() => !isAlive(recovering.pid!) || undefined);

    const reconnected = await fixture.connect();
    expect(await status(reconnected, project, second.taskId)).toMatchObject({
      status: "interrupted",
      reason: "service_restarted",
      detail: { recovery: { process: "unknown" } },
    });
    expect(fixture.launches()).toHaveLength(1);
  });

  it("runs a follow-up queued before the crash, telling Claude the previous execution was interrupted", async () => {
    const fixture = bridge({
      scenario: {
        turns: [
          { match: "Later", steps: [finished("Continued.")] },
          { steps: [{ signal: "running" }, { waitFor: "never" }] },
        ],
      },
    });
    const project = fixture.createRepository();
    const client = await fixture.connect();
    const { taskId, executionId } = await start(client, { project });
    await waitFor(() => fixture.signalled("running") || undefined);
    await sessionRecorded(client, project, taskId);
    const queued = await client.call("send_followup", {
      project,
      taskId,
      requestKey: "more-1",
      message: "Later.",
    });
    expect(queued.data).toMatchObject({ delivery: "queued", queuedBehind: executionId });

    await fixture.killService();
    const reconnected = await fixture.connect();

    const outcome = await finish(reconnected, project, taskId, queued.data.executionId);
    expect(outcome.status).toBe("completed");
    const after = await status(reconnected, project, taskId);
    expect(after.executions.map((execution: { status: string }) => execution.status)).toEqual([
      "interrupted",
      "completed",
    ]);
    expect(fixture.launches()[1]!.args).toContain(`--resume=${after.sessionId}`);
    expect(fixture.prompts()[1]).toContain("<previous-execution-interrupted>");
  });

  it("contrasts with a client disconnect, which leaves the work running in the same service", async () => {
    const fixture = bridge({
      scenario: {
        turns: [{ steps: [{ signal: "running" }, { waitFor: "go" }, finished("Finished.")] }],
      },
    });
    const project = fixture.createRepository();
    const client = await fixture.connect();
    const { taskId, executionId } = await start(client, { project });
    await waitFor(() => fixture.signalled("running") || undefined);
    const service = fixture.servicePid();

    await client.close();
    fixture.release("go");
    const next = await fixture.connect();

    const outcome = await finish(next, project, taskId, executionId);
    expect(outcome.status).toBe("completed");
    expect(outcome.detail).toBeUndefined();
    expect(fixture.servicePid()).toBe(service);
    expect(fixture.launches()).toHaveLength(1);
  });
});
