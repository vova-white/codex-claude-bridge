// Opt-in smoke check against the installed Claude Code and the user's existing
// login. It uses a temporary state directory, never the installed bridge's,
// and may consume subscription usage unless run with --readiness-only.
//
//   node scripts/smoke.ts [--readiness-only] [--bundle] [--claude <path>]
//
// --readiness-only  check readiness and stop; sends no prompt
// --bundle          launch dist/cli.mjs (run `bun run build` first) instead of src/cli.ts
// --claude <path>   Claude Code executable when `claude` is not on the PATH
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const { values: options } = parseArgs({
  options: {
    "readiness-only": { type: "boolean", default: false },
    bundle: { type: "boolean", default: false },
    claude: { type: "string" },
  },
});

interface Status {
  executionId: string;
  status: string;
  terminal: boolean;
  reason?: string;
  error?: { message?: string; action?: string };
}

interface Readiness {
  ready: boolean;
  problems: { code: string; message: string; action?: string }[];
  claude?: { version?: string };
  credentials?: { source?: string; verified?: boolean };
  models?: { value: string; displayName?: string; supportedEffortLevels?: string[] }[];
  service?: { pid?: number };
}

const cli = resolve(options.bundle ? "dist/cli.mjs" : "src/cli.ts");
if (!existsSync(cli)) {
  console.error(`${cli} does not exist; run \`bun run build\` first.`);
  process.exit(2);
}

// A short temporary path keeps the service socket within the platform limit.
const root = realpathSync(mkdtempSync(join(tmpdir(), "ccb-smoke-")));
const stateDir = join(root, "state");
const project = join(root, "repo");
const codeWord = `SMOKE-${randomBytes(3).toString("hex").toUpperCase()}`;
const env: Record<string, string> = {
  ...(Object.fromEntries(
    Object.entries(process.env).filter((entry) => entry[1] !== undefined),
  ) as Record<string, string>),
  CODEX_CLAUDE_BRIDGE_HOME: stateDir,
  CODEX_CLAUDE_BRIDGE_CALLER: "smoke",
};

const report: { ok: boolean; step: string; note: string }[] = [];
function check(step: string, ok: boolean, note = ""): boolean {
  report.push({ ok, step, note });
  return ok;
}

/** Bridge-composed failure details only; Claude's own content is never printed. */
function failure(status: Status): string {
  return [status.status, status.reason, status.error?.message, status.error?.action]
    .filter(Boolean)
    .join(" | ");
}

async function connect() {
  const client = new Client({ name: "bridge-smoke", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [cli, "mcp"],
      env,
      stderr: "ignore",
    }),
  );
  const call = async <T>(tool: string, args: Record<string, unknown>): Promise<T> => {
    const result = await client.callTool({ name: tool, arguments: args });
    const content = result.content as { type: string; text?: string }[];
    if (result.isError) {
      throw new Error(`${tool} failed: ${content.map((part) => part.text ?? "").join(" ")}`);
    }
    return (result.structuredContent ?? JSON.parse(content[0]?.text ?? "null")) as T;
  };
  return { call, close: () => client.close() };
}

type Connection = Awaited<ReturnType<typeof connect>>;

/** Waits for an execution to end; cancels the task when it asks for input or takes over 10 minutes. */
async function waitUntilDone(
  client: Connection,
  taskId: string,
  executionId: string,
): Promise<Status> {
  const deadline = Date.now() + 10 * 60_000;
  for (;;) {
    const status = await client.call<Status>("wait_task", {
      project,
      taskId,
      executionId,
      timeoutSeconds: 120,
    });
    if (status.terminal) return status;
    if (status.reason === "needs_input" || Date.now() > deadline) {
      // Leave nothing running: the service is stopped next.
      await client.call("cancel_task", { project, taskId });
      return status;
    }
  }
}

/** Prefers the cheapest model family readiness offers; otherwise Claude Code's default. */
function cheapestModel(models: Readiness["models"] = []): { model?: string; effort?: string } {
  for (const family of [/haiku/i, /sonnet/i]) {
    const model = models.find((entry) => family.test(`${entry.value} ${entry.displayName ?? ""}`));
    if (model) {
      return {
        model: model.value,
        ...(model.supportedEffortLevels?.includes("low") ? { effort: "low" } : {}),
      };
    }
  }
  return {};
}

/** The service this run started, as it reported itself; stopped at the end. */
let servicePid: number | undefined;

async function smoke(): Promise<void> {
  mkdirSync(stateDir, { mode: 0o700 });
  if (options.claude) {
    writeFileSync(
      join(stateDir, "config.json"),
      JSON.stringify({ claudeExecutable: resolve(options.claude) }),
    );
  }
  mkdirSync(project);
  const gitEnv = {
    ...env,
    GIT_AUTHOR_NAME: "Bridge Smoke",
    GIT_AUTHOR_EMAIL: "smoke@example.invalid",
    GIT_COMMITTER_NAME: "Bridge Smoke",
    GIT_COMMITTER_EMAIL: "smoke@example.invalid",
  };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: project, env: gitEnv });
  git("init", "--quiet", "--initial-branch=main");
  writeFileSync(join(project, "README.md"), `# Smoke fixture\n\nThe code word is ${codeWord}.\n`);
  git("add", ".");
  git("commit", "--quiet", "-m", "Initial commit");

  let client = await connect();
  const readiness = await client.call<Readiness>("readiness", { project });
  servicePid = readiness.service?.pid;
  const problems = readiness.problems.map((problem) => `${problem.code}: ${problem.action ?? ""}`);
  check(
    "readiness",
    readiness.ready,
    readiness.ready
      ? `credentials ${readiness.credentials?.source}, Claude Code ${readiness.claude?.version}`
      : problems.join("; "),
  );
  if (!readiness.ready || options["readiness-only"]) {
    await client.close();
    return;
  }

  const choice = cheapestModel(readiness.models);
  const started = await client.call<Status & { taskId: string }>("start_task", {
    project,
    requestKey: "smoke-1",
    assignment: "Read README.md in this repository and report the code word it contains.",
    context:
      "This is a smoke check of the Codex-Claude bridge. Do not change any file, do not start nested agents, and keep the summary to one sentence.",
    expectedResult: "A summary that states the code word exactly as written.",
    ...choice,
  });
  check("start_task", Boolean(started.taskId), `model ${choice.model ?? "default"}`);

  // Codex closing must not stop the task; a new client finds it.
  await client.close();
  client = await connect();
  const listed = await client.call<{ tasks: { taskId: string }[] }>("list_tasks", {
    project,
  });
  check(
    "reconnect",
    listed.tasks.some((task) => task.taskId === started.taskId),
    "list_tasks found the task after reconnecting",
  );

  const first = await waitUntilDone(client, started.taskId, started.executionId);
  const firstResult = await client.call<{ result: { summary?: string } | null }>("task_result", {
    project,
    taskId: started.taskId,
  });
  const firstSummary = firstResult.result?.summary ?? "";
  if (check("result", first.status === "completed", failure(first))) {
    check("result names the code word", firstSummary.includes(codeWord));
  }
  if (first.status !== "completed") {
    await client.close();
    return;
  }

  const followUp = await client.call<Status>("send_followup", {
    project,
    taskId: started.taskId,
    requestKey: "smoke-followup-1",
    message:
      "Without reading any file again, state the code word you reported, spelled backwards, in the summary.",
  });
  const second = await waitUntilDone(client, started.taskId, followUp.executionId);
  const secondResult = await client.call<{ result: { summary?: string } | null }>("task_result", {
    project,
    taskId: started.taskId,
    executionId: followUp.executionId,
  });
  if (check("follow-up", second.status === "completed", failure(second))) {
    const backwards = [...codeWord].toReversed().join("");
    check(
      "follow-up used the session",
      (secondResult.result?.summary ?? "").toUpperCase().includes(backwards),
    );
  }
  const original = await client.call<{ result: { summary?: string } | null }>("task_result", {
    project,
    taskId: started.taskId,
  });
  check("original result kept", original.result?.summary === firstSummary);
  await client.close();
}

function recordedPid(): number | undefined {
  try {
    return (JSON.parse(readFileSync(join(stateDir, "service.json"), "utf8")) as { pid?: number })
      .pid;
  } catch {
    return undefined;
  }
}

/** Stops the service this run started, by the PID it reported, and waits until it is gone. */
async function stopService(pid: number): Promise<void> {
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  if (!alive()) return;
  process.kill(pid, "SIGTERM");
  for (let waited = 0; alive() && waited < 10_000; waited += 100) {
    await new Promise((wake) => setTimeout(wake, 100));
  }
  if (alive()) process.kill(pid, "SIGKILL");
}

try {
  await smoke();
} catch (error) {
  check("run", false, error instanceof Error ? error.message : String(error));
} finally {
  // Without a readiness report, the PID the service recorded in this run's own state directory.
  servicePid ??= recordedPid();
  if (servicePid !== undefined) await stopService(servicePid);
  rmSync(root, { recursive: true, force: true });
}

for (const entry of report) {
  console.log(`${entry.ok ? "PASS" : "FAIL"} ${entry.step}${entry.note ? `: ${entry.note}` : ""}`);
}
const passed = report.length > 0 && report.every((entry) => entry.ok);
console.log(passed ? "Smoke check passed." : "Smoke check failed.");
process.exitCode = passed ? 0 : 1;
