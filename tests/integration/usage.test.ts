import { afterEach, describe, expect, it } from "vite-plus/test";
import type { Scenario, Step } from "../fixtures/fake-claude.ts";
import { BridgeFixture, isAlive, waitFor } from "../support/bridge.ts";

const fixtures: BridgeFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

const sonnet = "claude-sonnet-4-6";
const haiku = "claude-haiku-4-5";

/** One model's usage as Claude Code names it, scaled by `n`. */
const reportedModel = (n: number, thinking = true) => ({
  inputTokens: 11 * n,
  outputTokens: 21 * n,
  ...(thinking ? { thinkingTokens: 5 * n } : {}),
  cacheReadInputTokens: 31 * n,
  cacheCreationInputTokens: 41 * n,
  webSearchRequests: n,
  costUSD: 0.2 * n,
  contextWindow: 200_000,
  maxOutputTokens: 64_000,
});

/** The per-model figures the bridge reports for `reportedModel(n, thinking)`. */
const shownModel = (n: number, thinking = true) => ({
  input: 11 * n,
  output: 21 * n,
  ...(thinking ? { thinking: 5 * n } : {}),
  cacheRead: 31 * n,
  cacheCreation: 41 * n,
  webSearchRequests: n,
  costUsd: 0.2 * n,
  contextWindow: 200_000,
  maxOutputTokens: 64_000,
});

/** Usage fields of a result message as Claude Code names them, scaled by `n`. */
const reported = (n: number, model = sonnet) => ({
  total_cost_usd: 0.25 * n,
  duration_ms: 1_000 * n,
  duration_api_ms: 800 * n,
  num_turns: 3 * n,
  usage: {
    input_tokens: 10 * n,
    output_tokens: 20 * n,
    cache_read_input_tokens: 30 * n,
    cache_creation_input_tokens: 40 * n,
  },
  modelUsage: { [model]: reportedModel(n) },
});

/** The usage the bridge reports for `reported(n, model)`. */
const shown = (n: number, model = sonnet) => ({
  totalCostUsd: 0.25 * n,
  durationMs: 1_000 * n,
  apiDurationMs: 800 * n,
  turns: 3 * n,
  tokens: { input: 10 * n, output: 20 * n, cacheRead: 30 * n, cacheCreation: 40 * n },
  models: { [model]: shownModel(n) },
});

type Reported = ReturnType<typeof reported>;

const finished = (summary: string, usage?: Reported): Step => ({
  result: {
    text: summary,
    structured: { summary, evidence: [], failures: [], remainingWork: [], checks: [] },
    ...(usage ? { usage } : {}),
  },
});

/** A finished turn while a background nested agent runs, which leaves the execution waiting for it. */
const waitingForChild = (usage: Reported): Step[] => [
  { nestedStart: { id: "docs", description: "Review the docs", background: true } },
  finished("Started a background review of the docs.", usage),
];

async function setUp(scenario: Scenario, mode: "read-only" | "write" = "read-only") {
  const fixture = new BridgeFixture({ scenario });
  fixtures.push(fixture);
  const project = fixture.createRepository();
  const client = await fixture.connect();
  const started = await client.call("start_task", {
    project,
    requestKey: "usage-1",
    mode,
    assignment: "Coordinate the README work.",
    expectedResult: "Findings.",
  });
  expect(started.isError, started.text).toBe(false);
  const taskId = started.data.taskId as string;
  const status = async () => (await client.call("task_status", { project, taskId })).data;
  const wait = async () =>
    (await client.call("wait_task", { project, taskId, timeoutSeconds: 30 })).data;
  const waitingForChildren = () =>
    waitFor(async () => {
      const current = await status();
      return current.reason === "waiting_for_children" ? current : undefined;
    });
  return { fixture, project, client, taskId, status, wait, waitingForChildren };
}

describe("execution usage", () => {
  it("reports the figures of a completed execution's result in its state, not in its result or output", async () => {
    const usage = {
      ...reported(1),
      modelUsage: { [sonnet]: reportedModel(1), [haiku]: reportedModel(2, false) },
    };
    const { project, client, taskId, status, wait } = await setUp({
      turns: [{ steps: [finished("Reviewed.", usage)] }],
    });

    const expected = {
      ...shown(1),
      models: { [sonnet]: shownModel(1), [haiku]: shownModel(2, false) },
    };
    expect(await wait()).toMatchObject({ status: "completed", usage: expected });
    const current = await status();
    expect(current.executions[0].usage).toEqual(expected);

    const result = (await client.call("task_result", { project, taskId })).data;
    expect(result.result.summary).toBe("Reviewed.");
    expect(result).not.toHaveProperty("usage");
    expect((await client.call("read_output", { project, taskId })).data).not.toHaveProperty(
      "usage",
    );
  });

  it("reports usage of an execution that ended with an error result", async () => {
    const { status, wait } = await setUp({
      turns: [{ steps: [{ result: { isError: true, text: "Failed.", usage: reported(2) } }] }],
    });

    expect(await wait()).toMatchObject({ status: "failed", usage: shown(2) });
    expect((await status()).executions[0].usage).toEqual(shown(2));
  });

  it("has no usage for a cancelled execution, even after an earlier result", async () => {
    const { project, client, taskId, status, waitingForChildren } = await setUp({
      turns: [{ steps: [...waitingForChild(reported(1)), { waitFor: "never" }] }],
    });
    await waitingForChildren();

    const cancelled = (await client.call("cancel_task", { project, taskId })).data;
    expect(cancelled.cancellation).toBe("confirmed");
    expect(cancelled.executions[0]).toMatchObject({ status: "cancelled" });
    expect(cancelled.executions[0]).not.toHaveProperty("usage");
    expect((await status()).executions[0]).not.toHaveProperty("usage");
  });

  it("has no usage for an interrupted execution, even after an earlier result", async () => {
    const { fixture, project, taskId, waitingForChildren } = await setUp({
      turns: [{ steps: [...waitingForChild(reported(1)), { waitFor: "never" }] }],
    });
    await waitingForChildren();

    const pid = fixture.servicePid()!;
    process.kill(pid, "SIGKILL");
    await waitFor(() => !isAlive(pid) || undefined);
    const reconnected = await fixture.connect();
    const current = (await reconnected.call("task_status", { project, taskId })).data;
    expect(current.executions[0]).toMatchObject({ status: "interrupted" });
    expect(current.executions[0]).not.toHaveProperty("usage");
  });

  it("reports the last result's figures for an execution that ran several turns in one process", async () => {
    const { fixture, wait, waitingForChildren } = await setUp({
      turns: [
        {
          steps: [
            ...waitingForChild(reported(1)),
            { waitFor: "child" },
            { nestedEnd: { id: "docs", status: "completed", summary: "Docs reviewed" } },
            finished("README and docs reviewed.", reported(2)),
          ],
        },
      ],
    });
    expect(await waitingForChildren()).not.toHaveProperty("usage");

    fixture.release("child");
    expect(await wait()).toMatchObject({ status: "completed", usage: shown(2) });
  });

  it("reports each nested writer's usage apart from the executor's", async () => {
    const { status, wait } = await setUp(
      {
        turns: [
          {
            match: "Alpha writer",
            steps: [
              { writeFile: { path: "README.md", content: "# Alpha\n" } },
              { exec: ["git", "add", "-A"] },
              {
                exec: [
                  "git",
                  "-c",
                  "user.name=Child",
                  "-c",
                  "user.email=child@example.invalid",
                  "commit",
                  "-qm",
                  "docs: alpha title",
                ],
              },
              finished("Retitled the README.", reported(3, haiku)),
            ],
          },
          {
            match: "Coordinate",
            steps: [
              {
                mcpCall: {
                  tool: "start_nested_writer",
                  arguments: {
                    assignment: "Alpha writer: retitle the README.",
                    expectedResult: "A committed change.",
                  },
                },
              },
              { mcpCall: { tool: "wait_nested_writers" } },
              finished("Collected the alpha writer.", reported(1)),
            ],
          },
        ],
      },
      "write",
    );

    expect(await wait()).toMatchObject({ status: "completed", usage: shown(1) });
    const [execution] = (await status()).executions;
    expect(execution.usage).toEqual(shown(1));
    expect(execution.nestedWriters).toHaveLength(1);
    expect(execution.nestedWriters[0]).toMatchObject({ status: "completed" });
    expect(execution.nestedWriters[0].usage).toEqual(shown(3, haiku));
  });
});
