import { execFile } from "node:child_process";
import { realpathSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import {
  query,
  type AccountInfo,
  type McpServerStatus,
  type ModelInfo,
  type SDKUserMessage,
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
  models: Pick<ModelInfo, "value" | "displayName" | "description" | "supportedEffortLevels">[];
  git: { version?: string; supported: boolean; project?: { path: string; root?: string } };
  integrations: {
    configured: { name: string; status: string; error?: string }[];
    fromClaudeSettings: { name: string; status: string; scope?: string }[];
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
      fromClaudeSettings: [],
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
      `Cannot run ${executable} --version: ${version.error}`,
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

  const stderr: string[] = [];
  const abort = new AbortController();
  const session = query({
    prompt: withoutPrompt(abort.signal),
    options: {
      pathToClaudeCodeExecutable: executable,
      cwd: git.project?.root ?? paths.dir,
      env: claudeEnvironment(config),
      extraArgs: mcpConfigArgs(paths, config),
      abortController: abort,
      stderr: (data) => stderr.push(data),
    },
  });
  try {
    const init = await withTimeout(session.initializationResult(), initializeTimeoutMs);
    report.models = init.models.map(
      ({ value, displayName, description, supportedEffortLevels }) => ({
        value,
        displayName,
        description,
        ...(supportedEffortLevels ? { supportedEffortLevels } : {}),
      }),
    );
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
    for (const status of statuses) {
      if (status.name in config.mcpServers) {
        report.integrations.configured.push({
          name: status.name,
          status: status.status,
          ...(status.error ? { error: redact(status.error, secrets) } : {}),
        });
      } else {
        report.integrations.fromClaudeSettings.push({
          name: status.name,
          status: status.status,
          ...(status.scope ? { scope: status.scope } : {}),
        });
      }
    }
    for (const server of report.integrations.configured) {
      if (server.status !== "connected") {
        problem(
          "integration_unavailable",
          `MCP server "${server.name}" is ${server.status}${server.error ? `: ${server.error}` : ""}.`,
          `Check the "${server.name}" entry under "mcpServers" in ${paths.config}; Claude cannot use its tools until it connects.`,
          false,
        );
      }
    }
  } catch (error) {
    const detail = [(error as Error).message, stderr.join("").trim()].filter(Boolean).join(" — ");
    problem(
      "claude_start",
      `Claude Code could not start a session: ${detail}`,
      "Run `claude` in a terminal to check that it starts and is signed in, then retry.",
    );
    input.log(`readiness: Claude Code start failed: ${redact(detail, secrets)}`);
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
  writeFileSync(paths.claudeMcpConfig, JSON.stringify({ mcpServers: config.mcpServers }), {
    mode: 0o600,
  });
  return { "mcp-config": paths.claudeMcpConfig };
}

export function classifyCredentials(account: AccountInfo): ReadinessReport["credentials"] {
  const details = {
    ...(account.subscriptionType ? { subscriptionType: account.subscriptionType } : {}),
    ...(account.apiProvider ? { apiProvider: account.apiProvider } : {}),
    ...(account.apiKeySource ? { apiKeySource: account.apiKeySource } : {}),
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

async function claudeVersion(
  executable: string,
): Promise<{ value: string; error?: undefined } | { error: string }> {
  try {
    const { stdout } = await run(executable, ["--version"], { timeout: 15_000 });
    const match = /\d+\.\d+\.\d+/.exec(stdout);
    return match
      ? { value: match[0] }
      : { error: `unrecognized output ${JSON.stringify(stdout.trim())}` };
  } catch (error) {
    return { error: (error as Error).message };
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
      timer = setTimeout(() => reject(new Error(`no response within ${ms / 1000} s`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
