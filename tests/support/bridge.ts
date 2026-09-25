import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Scenario } from "../fixtures/fake-claude.ts";

export const fakeClaude = resolve("tests/fixtures/fake-claude.ts");
const cli = resolve("src/cli.ts");

export type { Scenario as FakeClaudeScenario } from "../fixtures/fake-claude.ts";

export interface BridgeOptions {
  scenario?: Scenario;
  config?: Record<string, unknown>;
  env?: Record<string, string>;
  /** How to launch the MCP entry point; defaults to the TypeScript source. */
  entry?: { command: string; args: string[]; cwd?: string };
}

export interface ToolResult {
  isError: boolean;
  text: string;
  data: any;
}

export interface BridgeClient {
  call(tool: string, args?: Record<string, unknown>): Promise<ToolResult>;
  listTools(): Promise<string[]>;
  close(): Promise<void>;
}

/**
 * An isolated bridge installation: a temporary state directory, a scripted
 * Claude Code executable, and MCP clients that launch the real entry point as
 * a subprocess. The background service it spawns is stopped on cleanup.
 */
export class BridgeFixture {
  readonly root = mkdtempSync(join(tmpdir(), "bridge-test-"));
  readonly stateDir = join(this.root, "state");
  readonly promptLog = join(this.root, "prompts.jsonl");
  private readonly clients = new Set<Client>();
  private readonly servicePids = new Set<number>();

  /** How MCP clients launch the entry point. */
  entry: NonNullable<BridgeOptions["entry"]>;

  constructor(options: BridgeOptions = {}) {
    this.entry = options.entry ?? { command: process.execPath, args: [cli, "mcp"] };
    mkdirSync(this.stateDir, { mode: 0o700 });
    const scenario = join(this.root, "scenario.json");
    writeFileSync(scenario, JSON.stringify(options.scenario ?? {}));
    writeFileSync(
      join(this.stateDir, "config.json"),
      JSON.stringify({ claudeExecutable: fakeClaude, ...options.config }),
    );
    this.env = {
      PATH: process.env.PATH ?? "",
      HOME: this.root,
      CODEX_CLAUDE_BRIDGE_HOME: this.stateDir,
      FAKE_CLAUDE_SCENARIO: scenario,
      FAKE_CLAUDE_PROMPT_LOG: this.promptLog,
      ...options.env,
    };
  }

  readonly env: Record<string, string>;

  async connect(): Promise<BridgeClient> {
    const transport = new StdioClientTransport({ ...this.entry, env: this.env, stderr: "pipe" });
    const client = new Client({ name: "bridge-test", version: "0.0.0" });
    await client.connect(transport);
    this.clients.add(client);
    return {
      call: async (tool, args = {}) => {
        const result = await client.callTool({ name: tool, arguments: args });
        const content = result.content as { type: string; text: string }[];
        const text = content.map((part) => part.text).join("\n");
        const data = result.structuredContent ?? tryParse(text);
        const pid = (data as { service?: { pid?: number } } | undefined)?.service?.pid;
        if (pid) this.servicePids.add(pid);
        return { isError: result.isError === true, text, data };
      },
      listTools: async () => (await client.listTools()).tools.map((tool) => tool.name),
      close: async () => {
        this.clients.delete(client);
        await client.close();
      },
    };
  }

  /** PID recorded by the running service, if any. */
  servicePid(): number | undefined {
    try {
      const pid = JSON.parse(readFileSync(join(this.stateDir, "service.json"), "utf8")).pid;
      this.servicePids.add(pid);
      return pid;
    } catch {
      return undefined;
    }
  }

  serviceLog(): string {
    try {
      return readFileSync(join(this.stateDir, "service.log"), "utf8");
    } catch {
      return "";
    }
  }

  async cleanup(): Promise<void> {
    await Promise.all([...this.clients].map((client) => client.close()));
    this.servicePid();
    await Promise.all([...this.servicePids].map((pid) => stopProcess(pid)));
    rmSync(this.root, { recursive: true, force: true });
  }
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitFor<T>(
  probe: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 5_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`Condition not met within ${timeoutMs} ms`);
    await new Promise((wake) => setTimeout(wake, 25));
  }
}

export async function stopProcess(pid: number): Promise<void> {
  if (!isAlive(pid)) return;
  process.kill(pid, "SIGTERM");
  try {
    await waitFor(() => !isAlive(pid) || undefined, 5_000);
  } catch {
    process.kill(pid, "SIGKILL");
    await waitFor(() => !isAlive(pid) || undefined, 5_000);
  }
}
