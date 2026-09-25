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
    structured: { summary, evidence: [], failures: [], remainingWork: [] },
  },
});

async function startTask(fixture: BridgeFixture, steps: Step[]) {
  fixture.scenario({ turns: [{ steps }] });
  const project = fixture.createRepository();
  const client = await fixture.connect();
  const started = await client.call("start_task", {
    project,
    requestKey: "progress-1",
    assignment: "Inspect the repository.",
    expectedResult: "Findings.",
  });
  expect(started.isError, started.text).toBe(false);
  return { client, project, ...(started.data as { taskId: string; executionId: string }) };
}

async function readAll(client: BridgeClient, args: Record<string, unknown>, limit = 2, from = 0) {
  const events: any[] = [];
  let after = from;
  for (;;) {
    const page = (await client.call("read_output", { ...args, after, limit })).data;
    events.push(...page.events);
    after = page.nextCursor;
    if (!page.hasMore) return events;
  }
}

describe("waiting and progress", () => {
  it("returns at once for a finished execution and keeps its identity", async () => {
    const fixture = bridge();
    const { client, project, taskId, executionId } = await startTask(fixture, [finished("Done.")]);
    await waitFor(async () => {
      const status = (await client.call("task_status", { project, taskId })).data;
      return status.terminal || undefined;
    });

    const began = Date.now();
    const waited = await client.call("wait_task", { project, taskId, timeoutSeconds: 60 });
    expect(Date.now() - began).toBeLessThan(5_000);
    expect(waited.data).toMatchObject({ executionId, status: "completed", timedOut: false });
  });

  it("times out without stopping the execution, then sees it finish", async () => {
    const fixture = bridge();
    const { client, project, taskId, executionId } = await startTask(fixture, [
      { assistant: "Working." },
      { waitFor: "go" },
      finished("Done late."),
    ]);

    const timedOut = await client.call("wait_task", {
      project,
      taskId,
      executionId,
      timeoutSeconds: 1,
    });
    expect(timedOut.data).toMatchObject({ executionId, timedOut: true, terminal: false });
    expect(["queued", "running"]).toContain(timedOut.data.status);

    fixture.release("go");
    const finishedWait = await client.call("wait_task", { project, taskId, timeoutSeconds: 30 });
    expect(finishedWait.data).toMatchObject({ executionId, status: "completed", timedOut: false });
    const result = await client.call("task_result", { project, taskId });
    expect(result.data.result.summary).toBe("Done late.");
  });

  it("ends a wait when the execution starts waiting for subscription capacity", async () => {
    const fixture = bridge();
    const { client, project, taskId } = await startTask(fixture, [
      { waitFor: "limit" },
      { rateLimit: { status: "rejected", resetsAt: 1_900_000_000 } },
      { waitFor: "never" },
    ]);

    const waiting = client.call("wait_task", { project, taskId, timeoutSeconds: 60 });
    fixture.release("limit");
    const woken = (await waiting).data;
    expect(woken).toMatchObject({
      status: "running",
      reason: "waiting_for_capacity",
      timedOut: false,
      detail: { resetsAt: 1_900_000_000 },
    });
  });

  it("reports the latest reset time when a capacity wait is renewed", async () => {
    const fixture = bridge();
    const { client, project, taskId } = await startTask(fixture, [
      { rateLimit: { status: "rejected", resetsAt: 1_900_000_000 } },
      { rateLimit: { status: "rejected", resetsAt: 1_900_000_000 } },
      { waitFor: "renew" },
      { rateLimit: { status: "rejected", resetsAt: 2_000_000_000 } },
      { waitFor: "never" },
    ]);
    await waitFor(async () => {
      const status = (await client.call("task_status", { project, taskId })).data;
      return status.reason === "waiting_for_capacity" || undefined;
    });
    fixture.release("renew");

    const renewed = await waitFor(async () => {
      const status = (await client.call("task_status", { project, taskId })).data;
      return status.detail?.resetsAt === 2_000_000_000 ? status : undefined;
    });
    expect(renewed).toMatchObject({ status: "running", reason: "waiting_for_capacity" });
    const waited = (await client.call("wait_task", { project, taskId, timeoutSeconds: 0 })).data;
    expect(waited.detail).toEqual({ resetsAt: 2_000_000_000 });
    const events = (await client.call("read_output", { project, taskId })).data.events;
    const waits = events.filter((event: { text: string }) => event.text.startsWith("Waiting"));
    expect(waits).toHaveLength(2);
  });

  it("rejects waiting for an execution the task does not have", async () => {
    const fixture = bridge();
    const { client, project, taskId } = await startTask(fixture, [finished("Done.")]);
    const result = await client.call("wait_task", {
      project,
      taskId,
      executionId: "exec_unknown",
      timeoutSeconds: 1,
    });
    expect(result.isError).toBe(true);
  });

  it("pages progress in order across reconnects without gaps or repeats", async () => {
    const fixture = bridge();
    const { client, project, taskId } = await startTask(fixture, [
      { assistant: "First look." },
      { toolUse: { name: "Read", input: { file_path: "README.md" } } },
      { assistant: "Second look." },
      finished("All done."),
    ]);
    await client.call("wait_task", { project, taskId, timeoutSeconds: 30 });

    const first = (await client.call("read_output", { project, taskId, limit: 3 })).data;
    expect(first.events).toHaveLength(3);
    expect(first.hasMore).toBe(true);
    await client.close();

    const reconnected = await fixture.connect();
    const rest = await readAll(reconnected, { project, taskId }, 2, first.nextCursor);
    const all = [...first.events, ...rest];
    const sequence = all.map((event) => event.seq);
    expect(sequence).toEqual([...sequence].toSorted((a, b) => a - b));
    expect(new Set(sequence).size).toBe(sequence.length);
    expect(all.map((event) => [event.kind, event.text])).toEqual([
      ["status", "Accepted."],
      ["status", "Running."],
      ["assistant", "First look."],
      ["tool", 'Read {"file_path":"README.md"}'],
      ["assistant", "Second look."],
      ["result", "All done."],
    ]);

    const empty = (
      await reconnected.call("read_output", { project, taskId, after: all.at(-1)!.seq })
    ).data;
    expect(empty).toMatchObject({ events: [], hasMore: false, nextCursor: all.at(-1)!.seq });
  });

  it("keeps configured secrets out of tool events even when JSON would escape them", async () => {
    const secret = 'tok"quo\\te-SECRET';
    const fixture = bridge({
      config: { mcpServers: { github: { command: "github-mcp", env: { TOKEN: secret } } } },
    });
    const { client, project, taskId } = await startTask(fixture, [
      { toolUse: { name: "Bash", input: { command: `echo ${secret}` } } },
      finished("Done."),
    ]);
    await client.call("wait_task", { project, taskId, timeoutSeconds: 30 });

    const events = await readAll(client, { project, taskId }, 50);
    const tool = events.find((event) => event.kind === "tool");
    expect(tool.text).toBe('Bash {"command":"echo [REDACTED]"}');
    expect(JSON.stringify(events)).not.toContain("SECRET");
  });

  it("bounds the result and serves all of it from the stored result, whatever its size", async () => {
    const summary = `${"s".repeat(17_000)}-END`;
    const evidence = Array.from({ length: 2_200 }, (_, index) => `evidence ${index}`);
    const fixture = bridge();
    const { client, project, taskId } = await startTask(fixture, [
      {
        result: { structured: { summary, evidence, failures: ["one failure"], remainingWork: [] } },
      },
    ]);
    await client.call("wait_task", { project, taskId, timeoutSeconds: 30 });

    const first = (await client.call("task_result", { project, taskId, maxChars: 1_200 })).data;
    expect(first.result.summary).toBe(summary.slice(0, 1_200));
    expect(first.result.evidence).toEqual([]);
    expect(first.truncated.next).toEqual({ part: 0, offset: 1_200 });

    const texts = new Map<number, string>([[0, first.result.summary]]);
    let next = first.truncated.next;
    while (next) {
      const page = (
        await client.call("task_result", { project, taskId, maxChars: 16_000, ...next })
      ).data;
      for (const part of page.parts) texts.set(part.part, (texts.get(part.part) ?? "") + part.text);
      next = page.truncated?.next;
    }
    expect(texts.get(0)).toBe(summary);
    expect([...texts.values()].slice(1)).toEqual([...evidence, "one failure"]);
  });

  it("keeps the task running when the client disconnects during a wait", async () => {
    const fixture = bridge();
    const { client, project, taskId } = await startTask(fixture, [
      { waitFor: "go" },
      finished("Done after the disconnect."),
    ]);
    const pending = client.call("wait_task", { project, taskId, timeoutSeconds: 60 });
    pending.catch(() => {});
    await client.close();

    fixture.release("go");
    const reconnected = await fixture.connect();
    const waited = await reconnected.call("wait_task", { project, taskId, timeoutSeconds: 30 });
    expect(waited.data.status).toBe("completed");
    const result = await reconnected.call("task_result", { project, taskId });
    expect(result.data.result.summary).toBe("Done after the disconnect.");
  });

  it("keeps progress and cursors after the service restarts", async () => {
    const fixture = bridge();
    const { client, project, taskId } = await startTask(fixture, [
      { assistant: "Before the crash." },
      { waitFor: "never" },
    ]);
    await waitFor(async () => {
      const page = (await client.call("read_output", { project, taskId })).data;
      return page.events.some((event: any) => event.text === "Before the crash.")
        ? page
        : undefined;
    });
    const before = (await client.call("read_output", { project, taskId })).data;
    const pid = fixture.servicePid()!;
    process.kill(pid, "SIGKILL");
    await waitFor(() => !isAlive(pid) || undefined);

    const reconnected = await fixture.connect();
    const after = (
      await reconnected.call("read_output", { project, taskId, after: before.nextCursor })
    ).data;
    expect(after.status).toBe("interrupted");
    expect(after.events.map((event: any) => [event.kind, event.text])).toEqual([
      ["status", "Interrupted: the bridge service stopped while this execution ran."],
    ]);
    expect(after.events[0].seq).toBeGreaterThan(before.nextCursor);
  });

  it("marks an event cut to fit the budget and returns it whole on request", async () => {
    const long = `${"x".repeat(4_990)}END`;
    const fixture = bridge();
    const { client, project, taskId } = await startTask(fixture, [
      { assistant: long },
      finished("Done."),
    ]);
    await client.call("wait_task", { project, taskId, timeoutSeconds: 30 });
    const events = await readAll(client, { project, taskId }, 50);
    const target = events.find((event) => event.kind === "assistant");

    const cut = (
      await client.call("read_output", { project, taskId, after: target.seq - 1, maxChars: 1_000 })
    ).data;
    expect(cut.events).toHaveLength(1);
    expect(cut.events[0]).toMatchObject({
      seq: target.seq,
      truncated: { shownChars: 1_000, totalChars: long.length },
    });
    expect(cut.nextCursor).toBe(target.seq);
    expect(cut.hasMore).toBe(true);

    const whole = (
      await client.call("read_output", {
        project,
        taskId,
        after: target.seq - 1,
        limit: 1,
        maxChars: 10_000,
      })
    ).data;
    expect(whole.events[0].text).toBe(long);
  });

  it("keeps only the newest events of a long execution and never its result", async () => {
    const fixture = bridge();
    const chatter: Step[] = Array.from({ length: 2_050 }, (_, index) => ({
      assistant: `note ${index}`,
    }));
    const { client, project, taskId } = await startTask(fixture, [
      ...chatter,
      finished("Survived."),
    ]);
    await client.call("wait_task", { project, taskId, timeoutSeconds: 60 });

    const page = (await client.call("read_output", { project, taskId, limit: 1 })).data;
    expect(page.retention.prunedEvents).toBeGreaterThan(0);
    expect(page.events[0].seq).toBe(page.retention.firstAvailableSeq);
    const notes = (await readAll(client, { project, taskId }, 200))
      .map((event) => event.text)
      .filter((text) => /^note \d+$/.test(text));
    expect(notes.length).toBeGreaterThan(1_900);
    expect(notes).toEqual(notes.map((_, index) => `note ${2_050 - notes.length + index}`));
    const result = await client.call("task_result", { project, taskId });
    expect(result.data.result.summary).toBe("Survived.");
  });
});
