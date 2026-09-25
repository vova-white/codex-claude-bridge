import { afterEach, describe, expect, it } from "vite-plus/test";
import type { Scenario, Step } from "../fixtures/fake-claude.ts";
import { BridgeFixture, isAlive, waitFor, type BridgeClient } from "../support/bridge.ts";

const fixtures: BridgeFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

const finished = (summary: string): Step => ({
  result: { text: summary, structured: { summary, evidence: [], failures: [], remainingWork: [] } },
});

async function setUp(scenario: Scenario) {
  const fixture = new BridgeFixture({ scenario });
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
  return {
    fixture,
    project,
    client,
    taskId: started.data.taskId as string,
    first: started.data.executionId as string,
  };
}

async function followUp(
  client: BridgeClient,
  project: string,
  taskId: string,
  requestKey: string,
  message: string,
) {
  const result = await client.call("send_followup", { project, taskId, requestKey, message });
  expect(result.isError, result.text).toBe(false);
  return result.data;
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

describe("follow-ups", () => {
  it("continue the same session as a new execution without replacing the original result", async () => {
    const { fixture, project, client, taskId, first } = await setUp({
      turns: [
        { match: "Check the tests too", steps: [finished("Tests reviewed.")] },
        { steps: [finished("README reviewed.")] },
      ],
    });
    await finish(client, project, taskId, first);
    const sessionId = (await client.call("task_status", { project, taskId })).data.sessionId;

    const sent = await followUp(client, project, taskId, "more-1", "Check the tests too.");
    expect(sent).toMatchObject({ created: true, delivery: "starting" });
    expect(sent.executionId).not.toBe(first);
    expect((await finish(client, project, taskId, sent.executionId)).status).toBe("completed");

    const original = await client.call("task_result", { project, taskId });
    expect(original.data).toMatchObject({
      executionId: first,
      result: { summary: "README reviewed." },
    });
    const later = await client.call("task_result", {
      project,
      taskId,
      executionId: sent.executionId,
    });
    expect(later.data.result.summary).toBe("Tests reviewed.");
    const [, resumed] = fixture.launches();
    expect(resumed!.args.join(" ")).toContain(`--resume=${sessionId}`);
    expect(fixture.prompts()[1]).toContain("Check the tests too.");
  });

  it("queue behind active work, deduplicate retries, and run in order", async () => {
    const { fixture, project, client, taskId, first } = await setUp({
      turns: [
        { match: "second", steps: [finished("Second done.")] },
        { steps: [{ waitFor: "go" }, finished("First done.")] },
      ],
    });
    await waitFor(() => fixture.prompts().length === 1 || undefined);

    const queued = await followUp(client, project, taskId, "more-1", "Do the second part.");
    expect(queued).toMatchObject({ status: "queued", delivery: "queued", queuedBehind: first });
    const retried = await followUp(client, project, taskId, "more-1", "Do the second part.");
    expect(retried).toMatchObject({ executionId: queued.executionId, created: false });
    const conflict = await client.call("send_followup", {
      project,
      taskId,
      requestKey: "more-1",
      message: "Something else.",
    });
    expect(conflict.isError).toBe(true);
    expect(fixture.launches()).toHaveLength(1);

    const second = await followUp(client, project, taskId, "more-2", "Then a second part.");
    expect(second).toMatchObject({ status: "queued", queuedBehind: queued.executionId });
    await client.close();
    const reconnected = await fixture.connect();
    const afterReconnect = await followUp(
      reconnected,
      project,
      taskId,
      "more-1",
      "Do the second part.",
    );
    expect(afterReconnect).toMatchObject({ executionId: queued.executionId, created: false });

    fixture.release("go");
    expect((await finish(reconnected, project, taskId, second.executionId)).status).toBe(
      "completed",
    );
    expect(fixture.prompts().map((prompt) => prompt.split("\n").find(Boolean))).toEqual([
      "<assignment>",
      "<follow-up>",
      "<follow-up>",
    ]);
    expect(fixture.prompts()[1]).toContain("Do the second part.");
    expect(fixture.prompts()[2]).toContain("Then a second part.");
    const status = (await reconnected.call("task_status", { project, taskId })).data;
    expect(
      status.executions.map((execution: { ordinal: number; status: string }) => [
        execution.ordinal,
        execution.status,
      ]),
    ).toEqual([
      [1, "completed"],
      [2, "completed"],
      [3, "completed"],
    ]);
  });

  it("wait in the follow-up call for their own execution, queued behind active work", async () => {
    const { fixture, project, client, taskId, first } = await setUp({
      turns: [
        { match: "Check the tests too", steps: [finished("Tests reviewed.")] },
        { steps: [{ waitFor: "go" }, finished("README reviewed.")] },
      ],
    });
    await waitFor(() => fixture.prompts().length === 1 || undefined);

    const sent = client.call("send_followup", {
      project,
      taskId,
      requestKey: "more-1",
      message: "Check the tests too.",
      waitSeconds: 30,
    });
    await waitFor(async () => {
      const status = (await client.call("task_status", { project, taskId })).data;
      return status.executions.length === 2 || undefined;
    });
    fixture.release("go");
    const waited = await sent;
    expect(waited.isError, waited.text).toBe(false);
    expect(waited.data).toMatchObject({
      created: true,
      delivery: "queued",
      queuedBehind: first,
      status: "completed",
      timedOut: false,
    });
    expect(waited.data.executionId).not.toBe(first);
    const result = await client.call("task_result", {
      project,
      taskId,
      executionId: waited.data.executionId,
    });
    expect(result.data.result.summary).toBe("Tests reviewed.");
  });

  it("run exactly once, after the original, when sent as it finishes", async () => {
    const { fixture, project, client, taskId, first } = await setUp({
      turns: [
        { match: "Race", steps: [finished("Follow-up done.")] },
        { steps: [finished("Original done.")] },
      ],
    });
    const sent = await followUp(client, project, taskId, "race-1", "Race the finish.");
    expect((await finish(client, project, taskId, sent.executionId)).status).toBe("completed");

    const status = (await client.call("task_status", { project, taskId })).data;
    expect(
      status.executions.map((execution: { executionId: string; status: string }) => [
        execution.executionId,
        execution.status,
      ]),
    ).toEqual([
      [first, "completed"],
      [sent.executionId, "completed"],
    ]);
    expect(fixture.launches()).toHaveLength(2);
    expect(fixture.prompts()[0]).toContain("Review the README.");
  });

  it("report a lost session instead of starting an unrelated conversation", async () => {
    const { fixture, project, client, taskId, first } = await setUp({
      turns: [{ steps: [finished("Done.")] }],
    });
    await finish(client, project, taskId, first);
    fixture.scenario({ lostSessions: true });

    const sent = await followUp(client, project, taskId, "more-1", "Continue.");
    const outcome = await finish(client, project, taskId, sent.executionId);
    expect(outcome).toMatchObject({ status: "failed", reason: "session_unavailable" });
    expect(outcome.error.action).toContain("new task");
    expect(fixture.prompts()).toHaveLength(1);
  });

  it("report a missing session when the first execution never reached Claude", async () => {
    const { fixture, project, client, taskId, first } = await setUp({
      account: { tokenSource: "none", apiProvider: "firstParty" },
    });
    await finish(client, project, taskId, first);

    const sent = await followUp(client, project, taskId, "more-1", "Continue.");
    const outcome = await finish(client, project, taskId, sent.executionId);
    expect(outcome).toMatchObject({ status: "failed", reason: "session_unavailable" });
    expect(outcome.error.message).toMatch(/^Execution failed with session_unavailable: /);
    expect(fixture.launches()).toHaveLength(1);
  });
});

describe("cancellation", () => {
  it("stops running work, cancels queued follow-ups, confirms termination, and is idempotent", async () => {
    const { fixture, project, client, taskId, first } = await setUp({
      turns: [{ steps: [{ waitFor: "never" }] }],
    });
    await waitFor(() => fixture.prompts().length === 1 || undefined);
    const queued = await followUp(client, project, taskId, "more-1", "Then this.");

    const cancelled = await client.call("cancel_task", { project, taskId });
    expect(cancelled.data).toMatchObject({
      cancellation: "confirmed",
      executions: [
        { executionId: first, status: "cancelled", detail: { processExited: true } },
        { executionId: queued.executionId, status: "cancelled" },
      ],
    });
    const pids = fixture.launches().map((launch) => launch.pid);
    expect(pids).toHaveLength(1);
    expect(isAlive(pids[0]!)).toBe(false);

    const again = await client.call("cancel_task", { project, taskId });
    expect(again.data).toMatchObject({ cancellation: "none_active" });
    expect(fixture.launches()).toHaveLength(1);
    const status = (await client.call("task_status", { project, taskId })).data;
    expect(status.executions.map((execution: { status: string }) => execution.status)).toEqual([
      "cancelled",
      "cancelled",
    ]);
  });

  it("confirms only once Claude Code has really exited, even if it ignores termination", async () => {
    const { fixture, project, client, taskId, first } = await setUp({
      turns: [{ steps: [{ ignoreTermination: true }, { waitFor: "never" }] }],
    });
    await waitFor(() => fixture.prompts().length === 1 || undefined);

    const cancelled = await client.call("cancel_task", { project, taskId });
    expect(cancelled.data).toMatchObject({
      cancellation: "confirmed",
      executions: [{ executionId: first, status: "cancelled", detail: { processExited: true } }],
    });
    expect(isAlive(fixture.launches()[0]!.pid)).toBe(false);
  }, 30_000);

  it("does not confirm cancellation while a finished turn's process is still running", async () => {
    const { fixture, project, client, taskId, first } = await setUp({
      turns: [
        {
          steps: [{ ignoreTermination: true }, finished("Done."), { signal: "answered" }],
        },
      ],
    });
    await waitFor(() => fixture.signalled("answered") || undefined);

    const cancelled = (await client.call("cancel_task", { project, taskId })).data;
    expect(isAlive(fixture.launches()[0]!.pid)).toBe(false);
    expect(cancelled).toMatchObject({
      cancellation: "confirmed",
      executions: [{ executionId: first, status: "completed" }],
    });
    const result = await client.call("task_result", { project, taskId });
    expect(result.data.result.summary).toBe("Done.");
  }, 30_000);

  it("reports a failed turn as cancelled when cancellation arrives before its process exits", async () => {
    const { fixture, project, client, taskId, first } = await setUp({
      turns: [
        {
          steps: [
            { ignoreTermination: true },
            { result: { isError: true, subtype: "error_during_execution", errors: ["boom"] } },
            { signal: "answered" },
          ],
        },
      ],
    });
    await waitFor(() => fixture.signalled("answered") || undefined);

    const cancelled = (await client.call("cancel_task", { project, taskId })).data;
    expect(isAlive(fixture.launches()[0]!.pid)).toBe(false);
    expect(cancelled).toMatchObject({
      cancellation: "confirmed",
      executions: [{ executionId: first, status: "cancelled", detail: { processExited: true } }],
    });
  }, 30_000);

  it("leaves a finished execution completed when cancellation arrives late", async () => {
    const { project, client, taskId, first } = await setUp({
      turns: [{ steps: [finished("Done.")] }],
    });
    await finish(client, project, taskId, first);

    const cancelled = await client.call("cancel_task", { project, taskId });
    expect(cancelled.data).toMatchObject({ cancellation: "none_active", executions: [] });
    const result = await client.call("task_result", { project, taskId });
    expect(result.data).toMatchObject({ status: "completed", result: { summary: "Done." } });
  });

  it("settles a cancellation racing completion in exactly one consistent state", async () => {
    const { fixture, project, client, taskId, first } = await setUp({
      turns: [{ steps: [{ assistant: "Almost there." }, finished("Done.")] }],
    });
    await waitFor(() => fixture.prompts().length === 1 || undefined);
    const cancelled = (await client.call("cancel_task", { project, taskId })).data;
    const settled = await finish(client, project, taskId, first);
    const result = (await client.call("task_result", { project, taskId })).data;

    expect(["completed", "cancelled"]).toContain(settled.status);
    if (settled.status === "completed") {
      expect(result.result.summary).toBe("Done.");
    } else {
      expect(result.result).toBeNull();
      expect(cancelled.cancellation).toBe("confirmed");
    }
    const again = (await client.call("task_status", { project, taskId })).data;
    expect(again.status).toBe(settled.status);
  });

  it("lets a new follow-up continue the session after cancellation", async () => {
    const { fixture, project, client, taskId } = await setUp({
      turns: [{ match: "again", steps: [finished("Resumed.")] }, { steps: [{ waitFor: "never" }] }],
    });
    await waitFor(() => fixture.prompts().length === 1 || undefined);
    await client.call("cancel_task", { project, taskId });

    const sent = await followUp(client, project, taskId, "more-2", "Try again.");
    expect((await finish(client, project, taskId, sent.executionId)).status).toBe("completed");
  });
});
