#!/usr/bin/env node
// Deterministic stand-in for the Claude Code executable. It speaks the
// stream-json control protocol used by the Claude Agent SDK and follows the
// scenario file named by FAKE_CLAUDE_SCENARIO. It never contacts a model.
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

export interface Scenario {
  version?: string;
  startupError?: string;
  account?: Record<string, unknown>;
  models?: unknown[];
  mcpStatus?: Record<string, { status: string; error?: string }>;
  settingsMcpServers?: { name: string; status: string; scope: string }[];
}

const scenarioPath = process.env.FAKE_CLAUDE_SCENARIO;
const scenario: Scenario = scenarioPath ? JSON.parse(readFileSync(scenarioPath, "utf8")) : {};
const args = process.argv.slice(2);

if (args.includes("--version")) {
  console.log(`${scenario.version ?? "2.1.282"} (Claude Code)`);
  process.exit(0);
}
if (scenario.startupError) {
  console.error(scenario.startupError);
  process.exit(1);
}

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

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.type === "user" && process.env.FAKE_CLAUDE_PROMPT_LOG) {
    appendFileSync(process.env.FAKE_CLAUDE_PROMPT_LOG, `${line}\n`);
  }
  if (message.type !== "control_request") return;
  const { request_id: requestId, request } = message;
  switch (request.subtype) {
    case "initialize":
      respond(requestId, {
        commands: [],
        agents: [],
        output_style: "default",
        available_output_styles: ["default"],
        models: scenario.models ?? [
          { value: "default", displayName: "Default", description: "Recommended model" },
        ],
        account: scenario.account ?? { subscriptionType: "Claude Max", apiProvider: "firstParty" },
        pid: process.pid,
      });
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
lines.on("close", () => process.exit(0));
