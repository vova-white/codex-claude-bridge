import { execFile, spawn, type ChildProcess } from "node:child_process";
import { realpathSync, writeFileSync } from "node:fs";
import { constants } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import {
  query,
  type AccountInfo,
  type McpServerStatus,
  type ModelInfo,
  type SDKUserMessage,
  type SpawnedProcess,
  type SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import { type BridgeConfig, configSecrets } from "../config.ts";
import { redact } from "../redact.ts";
import type { StatePaths } from "../state.ts";
import {
  agentSdkVersion,
  isCompatibleClaudeCode,
  supportedClaudeCodeVersion,
} from "./compatibility.ts";

const run = promisify(execFile);
const minimumGit = [2, 32];
const minimumNodeMajor = 24;
const initializeTimeoutMs = 30_000;
const integrationSettleMs = 5_000;

export interface Problem {
  code: string;
  message: string;
  action: string;
  /** Whether delegation cannot proceed until the problem is fixed. */
  blocking: boolean;
}

export type CredentialSource =
  | "subscription"
  | "api-key"
  | "third-party-provider"
  | "not-authenticated"
  | "unknown";

export interface ReadinessReport {
  ready: boolean;
  claude: {
    executable?: string;
    version?: string;
    compatible: boolean;
    supportedVersion: string;
    agentSdkVersion: string;
  };
  credentials: {
    source: CredentialSource;
    verified: boolean;
    subscriptionType?: string;
    apiProvider?: string;
    apiKeySource?: string;
  };
  models: Pick<ModelInfo, "value" | "supportedEffortLevels">[];
  git: { version?: string; supported: boolean; project?: { path: string; root?: string } };
  integrations: {
    configured: { name: string; status: string }[];
    /** Number of MCP servers from Claude Code's own settings, by status. */
    fromClaudeSettings: Record<string, number>;
    codexTools: { inherited: false; note: string };
  };
  problems: Problem[];
}

export interface ReadinessInput {
  paths: StatePaths;
  config: BridgeConfig;
  project?: string;
  log(message: string): void;
}

export async function checkReadiness(input: ReadinessInput): Promise<ReadinessReport> {
  const { paths, config } = input;
  const secrets = configSecrets(config);
  const problems: Problem[] = [];
  // Messages are composed here from known fields only; redact() is a backstop.
  const problem = (code: string, message: string, action: string, blocking = true) => {
    problems.push({ code, message: redact(message, secrets), action, blocking });
  };

  if (Number(process.versions.node.split(".")[0]) < minimumNodeMajor) {
    problem(
      "node_version",
      `The bridge service runs on Node.js ${process.version}.`,
      `Install Node.js ${minimumNodeMajor} or newer and make it the \`node\` on the PATH Codex uses.`,
    );
  }
  const git = await checkGit(input.project, problem);
  const report: ReadinessReport = {
    ready: false,
    claude: { compatible: false, supportedVersion: supportedClaudeCodeVersion, agentSdkVersion },
    credentials: { source: "unknown", verified: false },
    models: [],
    git,
    integrations: {
      configured: [],
      fromClaudeSettings: {},
      codexTools: {
        inherited: false,
        note: `Codex built-in tools, connectors, credentials, and approval policies are not available to Claude. Configure compatible MCP servers for Claude explicitly under "mcpServers" in ${paths.config}.`,
      },
    },
    problems,
  };

  const executable = claudeExecutable(config);
  if (!executable) {
    problem(
      "claude_missing",
      "Claude Code was not found on PATH.",
      `Install Claude Code, or set "claudeExecutable" in ${paths.config} to its absolute path.`,
    );
    return finish(report);
  }
  report.claude.executable = executable;

  const version = await claudeVersion(executable);
  if (version.error !== undefined) {
    problem(
      "claude_missing",
      `Cannot run ${executable} --version: ${version.error}.`,
      `Install Claude Code, or set "claudeExecutable" in ${paths.config} to its absolute path.`,
    );
    return finish(report);
  }
  report.claude.version = version.value;
  report.claude.compatible = isCompatibleClaudeCode(version.value);
  if (!report.claude.compatible) {
    problem(
      "claude_version",
      `Claude Code ${version.value} is not compatible with Claude Agent SDK ${agentSdkVersion}, which requires ${supportedClaudeCodeVersion} or a newer release of the same major version.`,
      "Update Claude Code (for example with `claude update`), or install a bridge release built for this Claude Code version.",
    );
  }

  const abort = new AbortController();
  const claude = claudeProcess();
  const session = query({
    prompt: withoutPrompt(abort.signal),
    options: {
      pathToClaudeCodeExecutable: executable,
      cwd: git.project?.root ?? paths.dir,
      env: claudeEnvironment(config),
      extraArgs: mcpConfigArgs(paths, config),
      abortController: abort,
      spawnClaudeCodeProcess: claude.spawn,
    },
  });
  try {
    const init = await withTimeout(session.initializationResult(), initializeTimeoutMs);
    // Model identifiers and effort levels only: descriptions are Claude Code's text.
    report.models = init.models
      .filter(({ value }) => modelIdentifier.test(value))
      .map(({ value, supportedEffortLevels }) => ({
        value,
        ...(supportedEffortLevels
          ? {
              supportedEffortLevels: supportedEffortLevels.filter((level) =>
                effortLevels.has(level),
              ),
            }
          : {}),
      }));
    report.credentials = classifyCredentials(init.account);
    const action = credentialAction(report.credentials);
    if (action) {
      problem(
        "credentials",
        `Claude Code is not using a verified subscription login (source: ${report.credentials.source}).`,
        action,
      );
    }
    const statuses = await settledIntegrations(() => session.mcpServerStatus(), config);
    // Only configured names and known statuses are reported: error text from an
    // MCP server can quote its credentials in forms no filter recognizes.
    // Servers from Claude's own settings are counted by status: their names are
    // Claude Code's text, not keys of the bridge configuration.
    const fromSettings: Record<string, number> = {};
    for (const name of Object.keys(config.mcpServers)) {
      const status = statuses.find((candidate) => candidate.name === name);
      report.integrations.configured.push({
        name,
        status: status && knownServerStatuses.has(status.status) ? status.status : "unknown",
      });
    }
    for (const status of statuses) {
      if (Object.hasOwn(config.mcpServers, status.name)) continue;
      const state = knownServerStatuses.has(status.status) ? status.status : "unknown";
      fromSettings[state] = (fromSettings[state] ?? 0) + 1;
    }
    report.integrations.fromClaudeSettings = fromSettings;
    for (const server of report.integrations.configured) {
      if (server.status !== "connected") {
        problem(
          "integration_unavailable",
          `MCP server "${server.name}" is ${server.status}.`,
          `Run \`claude\` in a terminal and inspect \`/mcp\` for the full error, then check the "${server.name}" entry under "mcpServers" in ${paths.config}. Claude cannot use its tools until it connects.`,
          false,
        );
      }
    }
  } catch (error) {
    const stage = claudeFailure(error, await claude.exit(), initializeTimeoutMs);
    problem(
      "claude_start",
      `Claude Code could not start a session (${stage}).`,
      "Run `claude` in a terminal to see the full error and check that it starts and is signed in, then retry.",
    );
    input.log(`readiness: Claude Code could not start a session (${stage})`);
  } finally {
    session.close();
    abort.abort();
  }
  return finish(report);
}

/** Streaming input that sends nothing, so initialization runs without a model request. */
function withoutPrompt(signal: AbortSignal): AsyncIterable<SDKUserMessage> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: () =>
        new Promise<IteratorResult<SDKUserMessage>>((resolve) =>
          signal.addEventListener("abort", () => resolve({ done: true, value: undefined }), {
            once: true,
          }),
        ),
    }),
  };
}

function finish(report: ReadinessReport): ReadinessReport {
  report.ready = !report.problems.some((problem) => problem.blocking);
  return report;
}

/** The environment Claude Code runs with: the service's own, plus an explicitly selected configuration directory. */
export function claudeEnvironment(config: BridgeConfig): NodeJS.ProcessEnv {
  return config.claudeConfigDir
    ? { ...process.env, CLAUDE_CONFIG_DIR: config.claudeConfigDir }
    : { ...process.env };
}

/**
 * Passes configured MCP servers through a private file rather than the command
 * line, where their credentials would be visible in the process list.
 */
export function mcpConfigArgs(paths: StatePaths, config: BridgeConfig): Record<string, string> {
  if (Object.keys(config.mcpServers).length === 0) return {};
  // autoApprove is the bridge's own setting, not part of Claude Code's format.
  const mcpServers = Object.fromEntries(
    Object.entries(config.mcpServers).map(([name, server]) => {
      const { autoApprove: _, ...entry } = server;
      return [name, entry];
    }),
  );
  writeFileSync(paths.claudeMcpConfig, JSON.stringify({ mcpServers }), { mode: 0o600 });
  return { "mcp-config": paths.claudeMcpConfig };
}

const apiKeySources = new Set([
  "ANTHROPIC_API_KEY",
  "apiKeyHelper",
  "/login managed key",
  "none",
  "user",
  "project",
  "org",
  "temporary",
  "oauth",
]);
const apiProviders = new Set([
  "firstParty",
  "bedrock",
  "vertex",
  "foundry",
  "anthropicAws",
  "anthropicGoogleCloud",
  "mantle",
  "gateway",
]);

const subscriptionTypes = new Set([
  "Claude Pro",
  "Claude Max",
  "Claude Team",
  "Claude Enterprise",
  "pro",
  "max",
  "team",
  "enterprise",
]);

/** Keeps an account field only when it has one of the values the bridge knows. */
function known(value: string | undefined, allowed: Set<string>): string | undefined {
  if (value === undefined) return undefined;
  return allowed.has(value) ? value : "other";
}

export function classifyCredentials(account: AccountInfo): ReadinessReport["credentials"] {
  // Account fields come from Claude Code, so only known values are reported.
  const subscriptionType = known(account.subscriptionType, subscriptionTypes);
  const apiProvider = known(account.apiProvider, apiProviders);
  const apiKeySource = known(account.apiKeySource, apiKeySources);
  const details = {
    ...(subscriptionType ? { subscriptionType } : {}),
    ...(apiProvider ? { apiProvider } : {}),
    ...(apiKeySource ? { apiKeySource } : {}),
  };
  if (account.apiProvider && account.apiProvider !== "firstParty") {
    return { source: "third-party-provider", verified: false, ...details };
  }
  if (account.apiKeySource && account.apiKeySource !== "none") {
    return { source: "api-key", verified: false, ...details };
  }
  if (account.subscriptionType) return { source: "subscription", verified: true, ...details };
  if (!account.tokenSource || account.tokenSource === "none") {
    return { source: "not-authenticated", verified: false, ...details };
  }
  return { source: "unknown", verified: false, ...details };
}

export function credentialAction(credentials: ReadinessReport["credentials"]): string | undefined {
  const login = "run `claude`, then `/login` with your Claude subscription account";
  switch (credentials.source) {
    case "subscription":
      return undefined;
    case "api-key":
      return `Claude Code would bill through ${credentials.apiKeySource}. Remove ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or apiKeyHelper from the bridge service environment and Claude settings, restart the bridge service, and ${login}.`;
    case "third-party-provider":
      return `Claude Code is configured for ${credentials.apiProvider}. The bridge requires your Claude subscription: remove the provider settings (such as CLAUDE_CODE_USE_BEDROCK or CLAUDE_CODE_USE_VERTEX) and ${login}.`;
    case "not-authenticated":
      return `Claude Code is not signed in: ${login}.`;
    case "unknown":
      return `Claude Code did not report a subscription login: ${login}.`;
  }
}

async function settledIntegrations(
  read: () => Promise<McpServerStatus[]>,
  config: BridgeConfig,
): Promise<McpServerStatus[]> {
  const deadline = Date.now() + integrationSettleMs;
  for (;;) {
    const statuses = await read();
    const pending = statuses.some(
      (status) => status.status === "pending" && status.name in config.mcpServers,
    );
    if (!pending || Date.now() > deadline) return statuses;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

const knownServerStatuses = new Set(["connected", "failed", "needs-auth", "pending", "disabled"]);
const knownSignals = new Set(Object.keys(constants.signals));
const effortLevels = new Set(["low", "medium", "high", "xhigh", "max"]);
/** Model values Claude Code accepts as identifiers, such as `sonnet` or `claude-opus-5[1m]`. */
const modelIdentifier = /^[a-z][a-z0-9.-]{0,62}(\[[0-9a-z]{1,8}\])?$/;

class TimeoutError extends Error {}

/** Why a process could not be used, determined by the bridge rather than quoted from its output. */
function processFailure(error: unknown, timeoutSeconds: number): string {
  const failure = error as NodeJS.ErrnoException & { killed?: boolean; code?: unknown };
  if (error instanceof TimeoutError || failure.killed) {
    return `no response within ${timeoutSeconds} s`;
  }
  if (failure.code === "ENOENT") return "the executable was not found";
  if (failure.code === "EACCES") return "the executable is not permitted to run";
  if (typeof failure.code === "number") return `it exited with code ${failure.code}`;
  return "it could not be run";
}

interface ProcessExit {
  code?: number | null;
  signal?: NodeJS.Signals | null;
  spawnError?: string | undefined;
}

/**
 * Spawns Claude Code for the Agent SDK (`spawnClaudeCodeProcess`) so a failure
 * can be described by the process's exit rather than by text; its stderr is
 * never read.
 */
export function claudeProcess() {
  const exit: ProcessExit = {};
  let child: ChildProcess | undefined;
  let exited = Promise.resolve();
  /** Whether the process exits within `ms`. */
  const exitsWithin = (ms: number) =>
    Promise.race([
      exited.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
    ]);
  return {
    spawn: (options: SpawnOptions): SpawnedProcess => {
      const process = spawn(options.command, options.args, {
        cwd: options.cwd,
        env: options.env as NodeJS.ProcessEnv,
        stdio: ["pipe", "pipe", "ignore"],
        signal: options.signal,
      });
      child = process;
      // Only the exit event proves the process is gone: an abort also emits
      // "error" while the process may still run. A spawn failure has no process.
      exited = new Promise((resolve) => {
        process.once("exit", (code, signal) => resolve(void Object.assign(exit, { code, signal })));
        process.once("error", (error: NodeJS.ErrnoException) => {
          if (process.pid !== undefined) return;
          resolve(void Object.assign(exit, { spawnError: error.code }));
        });
      });
      return process;
    },
    /** How the process ended; the SDK can report a failure before the exit event arrives. */
    exit: async (): Promise<ProcessExit> => {
      await exitsWithin(2_000);
      return exit;
    },
    /** Waits for the process to exit, killing it after a grace period; reports whether it exited. */
    stop: async (): Promise<boolean> => {
      if (!child) return true;
      if (await exitsWithin(10_000)) return true;
      child.kill("SIGKILL");
      return exitsWithin(5_000);
    },
  };
}

/** What went wrong with a Claude Code process, from a timeout or the process's own exit. */
export function claudeFailure(error: unknown, exit: ProcessExit, timeoutMs: number): string {
  if (error instanceof TimeoutError) return `no response within ${timeoutMs / 1000} s`;
  if (exit.spawnError === "ENOENT") return "the executable was not found";
  if (exit.spawnError === "EACCES") return "the executable is not permitted to run";
  if (typeof exit.code === "number") return `Claude Code exited with code ${exit.code}`;
  if (exit.signal && knownSignals.has(exit.signal)) {
    return `Claude Code was terminated by ${exit.signal}`;
  }
  return "Claude Code ended before answering";
}

async function claudeVersion(
  executable: string,
): Promise<{ value: string; error?: undefined } | { error: string }> {
  try {
    const { stdout } = await run(executable, ["--version"], { timeout: 15_000 });
    const match = /\d+\.\d+\.\d+/.exec(stdout);
    return match ? { value: match[0] } : { error: "it printed no recognizable version" };
  } catch (error) {
    return { error: processFailure(error, 15) };
  }
}

async function checkGit(
  project: string | undefined,
  problem: (code: string, message: string, action: string) => void,
): Promise<ReadinessReport["git"]> {
  const git: ReadinessReport["git"] = { supported: false };
  try {
    const { stdout } = await run("git", ["--version"], { timeout: 10_000 });
    const parts = (/(\d+)\.(\d+)/.exec(stdout) ?? []).slice(1).map(Number);
    const version = /\d+\.\d+(\.\d+)?/.exec(stdout)?.[0];
    if (version) git.version = version;
    git.supported =
      parts.length === 2 &&
      (parts[0]! > minimumGit[0]! || (parts[0] === minimumGit[0] && parts[1]! >= minimumGit[1]!));
    if (!git.supported) {
      problem(
        "git_version",
        `Git ${git.version ?? "(unknown version)"} is too old.`,
        "Install Git 2.32 or newer.",
      );
    }
  } catch {
    problem(
      "git_missing",
      "Git was not found on PATH.",
      "Install Git 2.32 or newer and make it available on the bridge service PATH.",
    );
    return git;
  }
  if (project !== undefined) {
    git.project = { path: project };
    try {
      const { stdout } = await run("git", ["-C", project, "rev-parse", "--show-toplevel"], {
        timeout: 10_000,
      });
      git.project.root = realpathSync(stdout.trim());
    } catch {
      problem(
        "project_not_git",
        `${project} is not inside a Git repository.`,
        "Pass the path of a Git checkout as the project.",
      );
    }
  }
  return git;
}

/** The configured Claude Code executable, or `claude` from the service PATH. */
export function claudeExecutable(config: BridgeConfig): string | undefined {
  return config.claudeExecutable ?? findOnPath("claude");
}

function findOnPath(command: string): string | undefined {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, command);
    try {
      realpathSync(candidate);
      return candidate;
    } catch {
      // Not in this directory.
    }
  }
  return undefined;
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TimeoutError(`no response within ${ms / 1000} s`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
