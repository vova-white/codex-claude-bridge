import { execFileSync } from "node:child_process";
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
  readonly launchLog = join(this.root, "launches.jsonl");
  readonly guidanceLog = join(this.root, "guidance.jsonl");
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
      FAKE_CLAUDE_LAUNCH_LOG: this.launchLog,
      FAKE_CLAUDE_GUIDANCE_LOG: this.guidanceLog,
      ...options.env,
    };
  }

  readonly env: Record<string, string>;

  /** Connects a new MCP client; `caller` sets its logical caller identity. */
  async connect(options: { caller?: string } = {}): Promise<BridgeClient> {
    const env = options.caller
      ? { ...this.env, CODEX_CLAUDE_BRIDGE_CALLER: options.caller }
      : this.env;
    const transport = new StdioClientTransport({ ...this.entry, env, stderr: "pipe" });
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

  /** Replaces the scripted Claude Code behaviour for processes started from now on. */
  scenario(scenario: Scenario): void {
    writeFileSync(join(this.root, "scenario.json"), JSON.stringify(scenario));
  }

  /** Lets a scripted `waitFor` step with this name continue. */
  release(name: string): void {
    writeFileSync(join(this.root, name), "");
  }

  /** Whether a scripted `signal` step with this name has run. */
  signalled(name: string): boolean {
    return existsSync(join(this.root, name));
  }

  /** Prompts the scripted Claude Code received, in order. */
  prompts(): string[] {
    return readLines(this.promptLog).map((line) => {
      const content = JSON.parse(line).message.content;
      return typeof content === "string"
        ? content
        : content.map((part: { text?: string }) => part.text ?? "").join("\n");
    });
  }

  /** The guidance appended to Claude Code's system prompt, per task session started. */
  guidance(): string[] {
    return readLines(this.guidanceLog)
      .map((line) => JSON.parse(line) as string)
      .filter(Boolean);
  }

  /** Arguments and working directory of each scripted Claude Code process. */
  launches(): { args: string[]; cwd: string; pid: number }[] {
    return readLines(this.launchLog)
      .map((line) => JSON.parse(line))
      .filter((launch) => !launch.args.includes("--version"));
  }

  /** Creates a Git repository with one commit and returns its path. */
  createRepository(name = "repo"): string {
    const path = join(this.root, name);
    mkdirSync(path);
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: path, env: { ...process.env, ...gitIdentity } });
    git("init", "--quiet", "--initial-branch=main");
    writeFileSync(join(path, "README.md"), "# Fixture\n");
    git("add", ".");
    git("commit", "--quiet", "-m", "Initial commit");
    return realpathSync(path);
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
    // Scripted Claude Code processes this fixture launched, such as ones told to ignore termination.
    await Promise.all(this.launches().map((launch) => stopProcess(launch.pid)));
    rmSync(this.root, { recursive: true, force: true });
  }
}

const gitIdentity = {
  GIT_AUTHOR_NAME: "Bridge Test",
  GIT_AUTHOR_EMAIL: "bridge@example.invalid",
  GIT_COMMITTER_NAME: "Bridge Test",
  GIT_COMMITTER_EMAIL: "bridge@example.invalid",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

function readLines(path: string): string[] {
  try {
    return readFileSync(path, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
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
