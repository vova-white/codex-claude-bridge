#!/usr/bin/env node
// Deterministic stand-in for the Claude Code executable. It speaks the
// stream-json control protocol used by the Claude Agent SDK and follows the
// scenario file named by FAKE_CLAUDE_SCENARIO. It never contacts a model.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Ajv } from "ajv";

/** One scripted action taken while answering a prompt. */
export type Step =
  | { assistant: string }
  | { assistantError: string; text?: string }
  | { toolUse: { name: string; input: Record<string, unknown> } }
  | { rateLimit: { status: "allowed" | "allowed_warning" | "rejected"; resetsAt?: number } }
  /** Waits until the named file exists, relative to the scenario file. */
  | { waitFor: string }
  /** Creates the named file next to the scenario file, so a test can wait for this point. */
  | { signal: string }
  /** Writes a file relative to the working directory, as a shell command could. */
  | { writeFile: { path: string; content: string } }
  /** Runs a command in the working directory, as the Bash tool could. */
  | { exec: string[] }
  /** From now on ignores SIGTERM and stdin closing, like a process that hangs on shutdown. */
  | { ignoreTermination: true }
  /** The Agent tool call and Claude Code's task_started for a nested agent; `parent` spawns it inside another one. */
  | {
      nestedStart: {
        id: string;
        description: string;
        agentType?: string;
        background?: boolean;
        parent?: string;
      };
    }
  /** A tool call made inside a nested agent. */
  | { nestedToolUse: { id: string; name: string; input: Record<string, unknown> } }
  | { nestedProgress: { id: string; summary: string } }
  /** Claude Code's task_notification for a nested agent. */
  | { nestedEnd: { id: string; status: "completed" | "failed" | "stopped"; summary?: string } }
  | {
      result: {
        text?: string;
        structured?: unknown;
        isError?: boolean;
        subtype?: string;
        errors?: string[];
      };
    }
  | { exit: { code: number; stderr?: string } }
  /**
   * Asks the SDK's canUseTool callback about a tool call, as Claude Code does
   * before running a tool that needs permission, then reports the decision as
   * assistant text: `<tool> allowed <updated input JSON>`, `<tool> denied <message>`,
   * or for AskUserQuestion `AskUserQuestion answered <answer per question JSON>`.
   * With `await: false` it continues without waiting for the decision.
   */
  | {
      canUseTool: {
        name: string;
        input: Record<string, unknown>;
        mcpServer?: { name: string; source: string };
        await?: false;
      };
    };

export interface Turn {
  /** Used for the first prompt containing this text; a turn without it matches any prompt. */
  match?: string;
  steps: Step[];
}

export interface Scenario {
  version?: string;
  startupError?: string;
  account?: Record<string, unknown>;
  models?: unknown[];
  mcpStatus?: Record<string, { status: string; error?: string }>;
  settingsMcpServers?: { name: string; status: string; scope: string }[];
  turns?: Turn[];
  /** Delays the answer to the SDK's initialize request until this file exists. */
  initializeWaitFor?: string;
  /** Makes `--resume` fail the way Claude Code does for a session it cannot find. */
  lostSessions?: boolean;
  /** Nested agents that accept a stop_task request but never report stopping. */
  ignoreStop?: string[];
}

const scenarioPath = process.env.FAKE_CLAUDE_SCENARIO;
const scenario: Scenario = scenarioPath ? JSON.parse(readFileSync(scenarioPath, "utf8")) : {};
const scenarioDir = scenarioPath ? dirname(scenarioPath) : process.cwd();
const args = process.argv.slice(2);
const resumeIndex = args.indexOf("--resume");
const resumed =
  resumeIndex >= 0
    ? args[resumeIndex + 1]
    : args.find((arg) => arg.startsWith("--resume="))?.slice("--resume=".length);
const sessionId = resumed ?? randomUUID();

if (args.includes("--version")) {
  console.log(`${scenario.version ?? "2.1.282"} (Claude Code)`);
  process.exit(0);
}
if (process.env.FAKE_CLAUDE_LAUNCH_LOG) {
  appendFileSync(
    process.env.FAKE_CLAUDE_LAUNCH_LOG,
    `${JSON.stringify({ args, cwd: process.cwd(), pid: process.pid })}\n`,
  );
}
// Claude Code refuses to start with a structured-output schema its validator rejects.
const schemaIndex = args.indexOf("--json-schema");
if (schemaIndex >= 0) {
  try {
    new Ajv().compile(JSON.parse(args[schemaIndex + 1] ?? ""));
  } catch (error) {
    console.error(`Error: --json-schema is not a valid JSON Schema: ${(error as Error).message}`);
    process.exit(1);
  }
}
if (scenario.startupError) {
  console.error(scenario.startupError);
  process.exit(1);
}

const defaultTurn: Turn = {
  steps: [
    {
      result: {
        text: "Done.",
        structured: { summary: "Done.", evidence: [], failures: [], remainingWork: [] },
      },
    },
  ],
};

function configuredMcpServers(): string[] {
  const names: string[] = [];
  args.forEach((arg, index) => {
    if (arg !== "--mcp-config") return;
    const value = args[index + 1] ?? "{}";
    const text = value.trimStart().startsWith("{") ? value : readFileSync(value, "utf8");
    names.push(...Object.keys(JSON.parse(text).mcpServers ?? {}));
  });
  return names;
}

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(requestId: string, response: unknown): void {
  send({
    type: "control_response",
    response: { subtype: "success", request_id: requestId, response },
  });
}

function assistant(content: unknown[], error?: string, parent: string | null = null): void {
  send({
    type: "assistant",
    message: {
      id: `msg_${randomUUID()}`,
      type: "message",
      role: "assistant",
      model: "fake",
      content,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
    parent_tool_use_id: parent,
    ...(error ? { error } : {}),
    uuid: randomUUID(),
    session_id: sessionId,
  });
}

function promptText(message: { message?: { content?: unknown } }): string {
  const content = message.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part: { text?: string }) => part.text ?? "").join("\n");
  }
  return "";
}

/** The Agent tool call that started a scripted nested agent. */
const agentToolUse = (id: string) => `toolu_agent_${id}`;

function taskNotification(id: string, status: string, summary = ""): void {
  send({
    type: "system",
    subtype: "task_notification",
    task_id: id,
    tool_use_id: agentToolUse(id),
    status,
    output_file: "",
    summary,
    uuid: randomUUID(),
    session_id: sessionId,
  });
}

async function waitForFile(path: string): Promise<void> {
  while (!existsSync(path)) await new Promise((wake) => setTimeout(wake, 20));
}

let initialized = false;
let ignoreTermination = false;
let queue = Promise.resolve();
/** Control requests sent to the SDK, by request ID, waiting for its control_response. */
const awaiting = new Map<string, (response: Record<string, unknown>) => void>();

async function canUseTool(step: Extract<Step, { canUseTool: unknown }>["canUseTool"]) {
  const requestId = `req_${randomUUID()}`;
  const answered = new Promise<Record<string, unknown>>((settle) =>
    awaiting.set(requestId, settle),
  );
  send({
    type: "control_request",
    request_id: requestId,
    request: {
      subtype: "can_use_tool",
      tool_name: step.name,
      input: step.input,
      tool_use_id: `toolu_${randomUUID()}`,
      ...(step.mcpServer ? { mcp_server: step.mcpServer } : {}),
    },
  });
  if (step.await === false) return;
  const response = await answered;
  const decision = (response.response ?? {}) as {
    behavior?: string;
    updatedInput?: unknown;
    message?: string;
  };
  assistant([
    {
      type: "text",
      text:
        decision.behavior !== "allow"
          ? `${step.name} denied ${decision.message ?? String(response.error)}`
          : step.name === "AskUserQuestion"
            ? `${step.name} answered ${JSON.stringify(answersByQuestion(step.input, decision.updatedInput))}`
            : `${step.name} allowed ${JSON.stringify(decision.updatedInput)}`,
    },
  ]);
}

/** The answer to each asked question, looked up by its text as Claude Code does. */
function answersByQuestion(asked: Record<string, unknown>, updated: unknown): (string | null)[] {
  const answers = (updated as { answers?: Record<string, string> } | undefined)?.answers ?? {};
  const questions = (asked.questions ?? []) as { question: string }[];
  return questions.map((item) => answers[item.question] ?? null);
}

async function answer(prompt: string): Promise<void> {
  if (!initialized) {
    initialized = true;
    send({
      type: "system",
      subtype: "init",
      session_id: sessionId,
      cwd: process.cwd(),
      model: "fake",
      tools: [],
      mcp_servers: [],
      permissionMode: "default",
      apiKeySource: "none",
      claude_code_version: scenario.version ?? "2.1.282",
      slash_commands: [],
      output_style: "default",
      skills: [],
      plugins: [],
      uuid: randomUUID(),
    });
  }
  const turn =
    scenario.turns?.find((candidate) => !candidate.match || prompt.includes(candidate.match)) ??
    defaultTurn;
  for (const step of turn.steps) {
    if ("assistant" in step) {
      assistant([{ type: "text", text: step.assistant }]);
    } else if ("assistantError" in step) {
      assistant([{ type: "text", text: step.text ?? step.assistantError }], step.assistantError);
    } else if ("toolUse" in step) {
      assistant([{ type: "tool_use", id: `toolu_${randomUUID()}`, ...step.toolUse }]);
    } else if ("rateLimit" in step) {
      send({
        type: "rate_limit_event",
        rate_limit_info: { ...step.rateLimit, rateLimitType: "five_hour" },
        uuid: randomUUID(),
        session_id: sessionId,
      });
    } else if ("signal" in step) {
      writeFileSync(resolve(scenarioDir, step.signal), "");
    } else if ("waitFor" in step) {
      await waitForFile(resolve(scenarioDir, step.waitFor));
    } else if ("writeFile" in step) {
      writeFileSync(resolve(process.cwd(), step.writeFile.path), step.writeFile.content);
    } else if ("ignoreTermination" in step) {
      ignoreTermination = true;
      process.on("SIGTERM", () => {});
      // Stay alive after stdin closes, as a hung process would.
      setInterval(() => {}, 60_000);
    } else if ("nestedStart" in step) {
      const {
        id,
        description,
        agentType = "general-purpose",
        background = false,
        parent,
      } = step.nestedStart;
      const input = { description, prompt: description, subagent_type: agentType };
      assistant(
        [{ type: "tool_use", id: agentToolUse(id), name: "Agent", input }],
        undefined,
        parent ? agentToolUse(parent) : null,
      );
      send({
        type: "system",
        subtype: "task_started",
        task_id: id,
        tool_use_id: agentToolUse(id),
        description,
        subagent_type: agentType,
        is_backgrounded: background,
        spawn_depth: parent ? 2 : 1,
        task_type: "local_agent",
        uuid: randomUUID(),
        session_id: sessionId,
      });
    } else if ("nestedToolUse" in step) {
      const { id, name, input } = step.nestedToolUse;
      assistant(
        [{ type: "tool_use", id: `toolu_${randomUUID()}`, name, input }],
        undefined,
        agentToolUse(id),
      );
    } else if ("nestedProgress" in step) {
      send({
        type: "system",
        subtype: "task_progress",
        task_id: step.nestedProgress.id,
        tool_use_id: agentToolUse(step.nestedProgress.id),
        description: step.nestedProgress.id,
        summary: step.nestedProgress.summary,
        usage: { total_tokens: 0, tool_uses: 0, duration_ms: 0 },
        uuid: randomUUID(),
        session_id: sessionId,
      });
    } else if ("nestedEnd" in step) {
      taskNotification(step.nestedEnd.id, step.nestedEnd.status, step.nestedEnd.summary);
    } else if ("exec" in step) {
      const [command = "true", ...commandArgs] = step.exec;
      execFileSync(command, commandArgs, { cwd: process.cwd() });
    } else if ("result" in step) {
      const { text = "", structured, isError = false, subtype = "success", errors } = step.result;
      send({
        type: "result",
        subtype,
        is_error: isError,
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 1,
        result: text,
        stop_reason: null,
        total_cost_usd: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
        modelUsage: {},
        permission_denials: [],
        ...(structured === undefined ? {} : { structured_output: structured }),
        ...(errors ? { errors } : {}),
        uuid: randomUUID(),
        session_id: sessionId,
      });
    } else if ("canUseTool" in step) {
      await canUseTool(step.canUseTool);
    } else if ("exit" in step) {
      if (step.exit.stderr) process.stderr.write(`${step.exit.stderr}\n`);
      process.exit(step.exit.code);
    }
  }
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.type === "user") {
    if (process.env.FAKE_CLAUDE_PROMPT_LOG) {
      appendFileSync(process.env.FAKE_CLAUDE_PROMPT_LOG, `${line}\n`);
    }
    const prompt = promptText(message);
    queue = queue.then(() => answer(prompt));
    return;
  }
  if (message.type === "control_response") {
    awaiting.get(message.response.request_id)?.(message.response);
    awaiting.delete(message.response.request_id);
    return;
  }
  if (message.type !== "control_request") return;
  const { request_id: requestId, request } = message;
  switch (request.subtype) {
    case "initialize":
      if (resumed && scenario.lostSessions) {
        // Claude Code answers an unknown --resume with an error result and exits.
        send({
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          errors: [`No conversation found with session ID: ${resumed}`],
          duration_ms: 0,
          duration_api_ms: 0,
          num_turns: 0,
          stop_reason: null,
          total_cost_usd: 0,
          usage: { input_tokens: 0, output_tokens: 0 },
          modelUsage: {},
          permission_denials: [],
          uuid: randomUUID(),
          session_id: resumed,
        });
        process.stderr.write(`No conversation found with session ID: ${resumed}\n`);
        process.exit(1);
      }
      void (
        scenario.initializeWaitFor
          ? waitForFile(resolve(scenarioDir, scenario.initializeWaitFor))
          : Promise.resolve()
      ).then(() =>
        respond(requestId, {
          commands: [],
          agents: [],
          output_style: "default",
          available_output_styles: ["default"],
          models: scenario.models ?? [
            { value: "default", displayName: "Default", description: "Recommended model" },
            { value: "sonnet", displayName: "Sonnet", description: "Everyday model" },
          ],
          account: scenario.account ?? {
            subscriptionType: "Claude Max",
            apiProvider: "firstParty",
          },
          pid: process.pid,
        }),
      );
      break;
    case "mcp_status":
      respond(requestId, {
        mcpServers: [
          ...configuredMcpServers().map((name) => ({
            name,
            status: scenario.mcpStatus?.[name]?.status ?? "connected",
            error: scenario.mcpStatus?.[name]?.error,
            scope: "dynamic",
          })),
          ...(scenario.settingsMcpServers ?? []),
        ],
      });
      break;
    case "stop_task":
      if (!scenario.ignoreStop?.includes(request.task_id)) {
        taskNotification(request.task_id, "stopped");
      }
      respond(requestId, {});
      break;
    default:
      send({
        type: "control_response",
        response: {
          subtype: "error",
          request_id: requestId,
          error: `Unsupported ${request.subtype}`,
        },
      });
  }
});
// Like Claude Code, stop when the SDK closes stdin, even in the middle of a turn.
lines.on("close", () => {
  if (!ignoreTermination) process.exit(0);
});
