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
  /** Writes a file relative to the working directory, as a shell command could. */
  | { writeFile: { path: string; content: string } }
  /** Runs a command in the working directory, as the Bash tool could. */
  | { exec: string[] }
  | {
      result: {
        text?: string;
        structured?: unknown;
        isError?: boolean;
        subtype?: string;
        errors?: string[];
      };
    }
  | { exit: { code: number; stderr?: string } };

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
}

const scenarioPath = process.env.FAKE_CLAUDE_SCENARIO;
const scenario: Scenario = scenarioPath ? JSON.parse(readFileSync(scenarioPath, "utf8")) : {};
const scenarioDir = scenarioPath ? dirname(scenarioPath) : process.cwd();
const args = process.argv.slice(2);
const sessionId = randomUUID();

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

function assistant(content: unknown[], error?: string): void {
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
    parent_tool_use_id: null,
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

async function waitForFile(path: string): Promise<void> {
  while (!existsSync(path)) await new Promise((wake) => setTimeout(wake, 20));
}

let initialized = false;
let queue = Promise.resolve();

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
    } else if ("waitFor" in step) {
      await waitForFile(resolve(scenarioDir, step.waitFor));
    } else if ("writeFile" in step) {
      writeFileSync(resolve(process.cwd(), step.writeFile.path), step.writeFile.content);
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
  if (message.type !== "control_request") return;
  const { request_id: requestId, request } = message;
  switch (request.subtype) {
    case "initialize":
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
lines.on("close", () => process.exit(0));
