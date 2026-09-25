import { afterEach, describe, expect, it } from "vite-plus/test";
import type { Scenario, Step } from "../fixtures/fake-claude.ts";
import { BridgeFixture, isAlive, waitFor, type BridgeClient } from "../support/bridge.ts";

const fixtures: BridgeFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

const finished = (summary: string, failures: string[] = []): Step => ({
  result: { text: summary, structured: { summary, evidence: [], failures, remainingWork: [] } },
});

async function setUp(scenario: Scenario) {
  const fixture = new BridgeFixture({ scenario });
  fixtures.push(fixture);
  const project = fixture.createRepository();
  const client = await fixture.connect();
  const started = await client.call("start_task", {
    project,
    requestKey: "task-1",
    assignment: "Review the README and the docs.",
    expectedResult: "Findings.",
  });
  expect(started.isError, started.text).toBe(false);
  const taskId = started.data.taskId as string;
  const status = async () => (await client.call("task_status", { project, taskId })).data;
  return { fixture, project, client, taskId, first: started.data.executionId as string, status };
}

async function finish(client: BridgeClient, project: string, taskId: string, executionId: string) {
  return (await client.call("wait_task", { project, taskId, executionId, timeoutSeconds: 30 }))
    .data;
}

describe("nested agents", () => {
  it("keep a finished executor turn waiting for children, then complete with the executor's later result", async () => {
    const { fixture, project, client, taskId, first, status } = await setUp({
      turns: [
        {
          steps: [
            { nestedStart: { id: "docs", description: "Review the docs", background: true } },
            finished("Started a background review of the docs."),
            { waitFor: "child" },
            { nestedEnd: { id: "docs", status: "completed", summary: "Docs reviewed" } },
            finished("README and docs reviewed."),
          ],
        },
      ],
    });
    const waiting = await waitFor(async () => {
      const current = await status();
      return current.reason === "waiting_for_children" ? current : undefined;
    });
    expect(waiting).toMatchObject({ status: "running", terminal: false });
    expect(waiting.executions[0].nested).toMatchObject([
      {
        taskId: "docs",
        description: "Review the docs",
        agentType: "general-purpose",
        background: true,
        status: "running",
      },
    ]);
    const timedOut = await client.call("wait_task", { project, taskId, timeoutSeconds: 1 });
    expect(timedOut.data).toMatchObject({ timedOut: true, reason: "waiting_for_children" });
    expect((await client.call("task_result", { project, taskId })).data.result).toBeNull();

    fixture.release("child");
    expect(await finish(client, project, taskId, first)).toMatchObject({ status: "completed" });
    const result = await client.call("task_result", { project, taskId });
    expect(result.data.result.summary).toBe("README and docs reviewed.");
    expect((await status()).executions[0].nested).toMatchObject([
      { taskId: "docs", status: "completed", summary: "Docs reviewed" },
    ]);
  });

  it("complete with the executor's result when children finish first, recording who started whom and their progress", async () => {
    const { project, client, taskId, first, status } = await setUp({
      turns: [
        {
          steps: [
            { nestedStart: { id: "docs", description: "Review the docs", agentType: "Explore" } },
            { nestedToolUse: { id: "docs", name: "Read", input: { file_path: "docs/a.md" } } },
            { nestedStart: { id: "links", description: "Check the links", parent: "docs" } },
            { nestedProgress: { id: "links", summary: "Checking external links" } },
            { nestedEnd: { id: "links", status: "completed", summary: "Links checked" } },
            { nestedEnd: { id: "docs", status: "completed", summary: "Docs reviewed" } },
            finished("README and docs reviewed."),
          ],
        },
      ],
    });
    expect(await finish(client, project, taskId, first)).toMatchObject({ status: "completed" });
    const [docs, links] = (await status()).executions[0].nested;
    expect(docs).toMatchObject({
      taskId: "docs",
      agentType: "Explore",
      background: false,
      depth: 1,
      status: "completed",
      termination: "reported",
    });
    expect(docs.parentToolUseId).toBeUndefined();
    expect(links).toMatchObject({
      taskId: "links",
      parentToolUseId: docs.toolUseId,
      depth: 2,
      status: "completed",
    });
    const events = (await client.call("read_output", { project, taskId })).data.events;
    const nested = events
      .filter((event: { kind: string }) => event.kind === "nested")
      .map((event: { text: string }) => event.text);
    expect(nested).toEqual([
      "docs started: Review the docs",
      'docs: Read {"file_path":"docs/a.md"}',
      'docs: Agent {"description":"Check the links","prompt":"Check the links","subagent_type":"general-purpose"}',
      "links started: Check the links",
      "links: Checking external links",
      "links completed: Links checked",
      "docs completed: Docs reviewed",
    ]);
  });

  it("wait through a nested failure and interim results, keeping only the executor's result after the last child", async () => {
    const { fixture, project, client, taskId, first, status } = await setUp({
      turns: [
        {
          steps: [
            { nestedStart: { id: "docs", description: "Review the docs", background: true } },
            { nestedStart: { id: "tests", description: "Review the tests", background: true } },
            finished("Started two reviews."),
            { nestedEnd: { id: "docs", status: "failed", summary: "Docs could not be read" } },
            finished("Docs review failed; waiting for the tests review."),
            { signal: "interim" },
            { waitFor: "child" },
            { nestedEnd: { id: "tests", status: "completed", summary: "Tests reviewed" } },
            finished("Tests reviewed.", ["The docs review failed."]),
          ],
        },
      ],
    });
    await waitFor(() => fixture.signalled("interim") || undefined);
    const waiting = await waitFor(async () => {
      const current = await status();
      return current.executions[0].nested?.[0]?.status === "failed" ? current : undefined;
    });
    expect(waiting).toMatchObject({
      status: "running",
      reason: "waiting_for_children",
      detail: { runningNested: 1 },
    });

    fixture.release("child");
    expect(await finish(client, project, taskId, first)).toMatchObject({ status: "completed" });
    const result = (await client.call("task_result", { project, taskId })).data.result;
    expect(result).toMatchObject({
      summary: "Tests reviewed.",
      failures: ["The docs review failed."],
    });
    expect((await status()).executions[0].nested).toMatchObject([
      { taskId: "docs", status: "failed", summary: "Docs could not be read" },
      { taskId: "tests", status: "completed", summary: "Tests reviewed" },
    ]);
  });

  it("ignore events that arrive after the execution completed", async () => {
    const { project, client, taskId, first, status } = await setUp({
      turns: [
        {
          steps: [
            { nestedStart: { id: "docs", description: "Review the docs", background: true } },
            finished("Started a review."),
            { nestedEnd: { id: "docs", status: "completed", summary: "Docs reviewed" } },
            { nestedEnd: { id: "docs", status: "failed", summary: "Duplicate" } },
            finished("Docs reviewed."),
            { nestedEnd: { id: "docs", status: "failed", summary: "Late" } },
            { nestedStart: { id: "late", description: "A late agent", background: true } },
            finished("A late result."),
          ],
        },
      ],
    });
    expect(await finish(client, project, taskId, first)).toMatchObject({ status: "completed" });
    const current = await status();
    expect(current).toMatchObject({ status: "completed" });
    expect(current.executions[0].nested).toMatchObject([
      { taskId: "docs", status: "completed", summary: "Docs reviewed" },
    ]);
    expect(current.executions[0].nested).toHaveLength(1);
    const result = await client.call("task_result", { project, taskId });
    expect(result.data.result.summary).toBe("Docs reviewed.");
  });

  it("report an execution whose Claude Code exits while children run as failed, not completed", async () => {
    const { project, client, taskId, first, status } = await setUp({
      turns: [
        {
          steps: [
            { nestedStart: { id: "docs", description: "Review the docs", background: true } },
            finished("Started a review."),
            { exit: { code: 0 } },
          ],
        },
      ],
    });
    expect(await finish(client, project, taskId, first)).toMatchObject({
      status: "failed",
      reason: "provider_error",
    });
    expect((await status()).executions[0].nested).toMatchObject([
      { taskId: "docs", status: "stopped", termination: "process_exit" },
    ]);
    expect((await client.call("task_result", { project, taskId })).data.result).toBeNull();
  });

  it("keep the original result, with its nested agents, when a follow-up runs", async () => {
    const { project, client, taskId, first, status } = await setUp({
      turns: [
        { match: "Anything else", steps: [finished("Nothing else.")] },
        {
          steps: [
            { nestedStart: { id: "docs", description: "Review the docs", background: true } },
            finished("Started a review."),
            { nestedEnd: { id: "docs", status: "completed", summary: "Docs reviewed" } },
            finished("README and docs reviewed."),
          ],
        },
      ],
    });
    await finish(client, project, taskId, first);
    const sent = await client.call("send_followup", {
      project,
      taskId,
      requestKey: "more-1",
      message: "Anything else?",
    });
    expect(await finish(client, project, taskId, sent.data.executionId)).toMatchObject({
      status: "completed",
    });

    const original = await client.call("task_result", { project, taskId });
    expect(original.data).toMatchObject({
      executionId: first,
      result: { summary: "README and docs reviewed." },
    });
    const [firstExecution, followUp] = (await status()).executions;
    expect(firstExecution.nested).toMatchObject([{ taskId: "docs", status: "completed" }]);
    expect(followUp.nested).toBeUndefined();
  });
});

describe("cancellation with nested agents", () => {
  it("stops known nested agents and discloses the ones Claude Code did not report stopping", async () => {
    const { fixture, project, client, taskId, first } = await setUp({
      ignoreStop: ["tests"],
      turns: [
        {
          steps: [
            { nestedStart: { id: "docs", description: "Review the docs", background: true } },
            { nestedStart: { id: "tests", description: "Review the tests", background: true } },
            finished("Started two reviews."),
            { signal: "waiting" },
            { waitFor: "never" },
          ],
        },
      ],
    });
    await waitFor(() => fixture.signalled("waiting") || undefined);
    await waitFor(async () => {
      const current = (await client.call("task_status", { project, taskId })).data;
      return current.reason === "waiting_for_children" || undefined;
    });

    const cancelled = (await client.call("cancel_task", { project, taskId })).data;
    expect(cancelled).toMatchObject({
      cancellation: "confirmed",
      executions: [
        {
          executionId: first,
          status: "cancelled",
          detail: { processExited: true },
          nested: [
            { taskId: "docs", status: "stopped", termination: "reported" },
            { taskId: "tests", status: "stopped", termination: "process_exit" },
          ],
        },
      ],
    });
    expect(cancelled.controlGap).toContain("1 nested agent");
    expect(isAlive(fixture.launches()[0]!.pid)).toBe(false);
  }, 30_000);

  it("confirms without a control gap when Claude Code reports every nested agent stopped", async () => {
    const { project, client, taskId, status } = await setUp({
      turns: [
        {
          steps: [
            { nestedStart: { id: "docs", description: "Review the docs" } },
            { waitFor: "never" },
          ],
        },
      ],
    });
    await waitFor(async () => (await status()).executions[0].nested || undefined);
    const cancelled = (await client.call("cancel_task", { project, taskId })).data;
    expect(cancelled).toMatchObject({
      cancellation: "confirmed",
      executions: [{ nested: [{ taskId: "docs", status: "stopped", termination: "reported" }] }],
    });
    expect(cancelled.controlGap).toBeUndefined();
  });
});

describe("recovery with nested agents", () => {
  it("reports nested agents of an interrupted execution as ended with its process", async () => {
    const { fixture, project, taskId, status } = await setUp({
      turns: [
        {
          steps: [
            { nestedStart: { id: "docs", description: "Review the docs", background: true } },
            { waitFor: "never" },
          ],
        },
      ],
    });
    await waitFor(async () => (await status()).executions[0].nested || undefined);
    const pid = fixture.servicePid()!;
    process.kill(pid, "SIGKILL");
    await waitFor(() => !isAlive(pid) || undefined);

    const reconnected = await fixture.connect();
    const recovered = (await reconnected.call("task_status", { project, taskId })).data;
    expect(recovered.executions[0]).toMatchObject({
      status: "interrupted",
      detail: { recovery: { process: "ended" } },
      nested: [{ taskId: "docs", status: "stopped", termination: "process_exit" }],
    });
  });
});
