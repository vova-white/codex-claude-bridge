import { randomBytes } from "node:crypto";
import { appendFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { checkReadiness } from "../claude/readiness.ts";
import { ConfigError, configSecrets, loadConfig } from "../config.ts";
import { serve, ServiceError } from "../ipc.ts";
import { errorOrigin, redact } from "../redact.ts";
import { secureStateDir, type StatePaths } from "../state.ts";
import { openStore, StoreLockedError } from "./store.ts";
import { TaskService } from "./tasks.ts";
import metadata from "../../package.json" with { type: "json" };

const maxLogBytes = 1024 * 1024;

/** Operations the service implements. Only these are advertised to Codex. */
export const operations = ["readiness", "start_task", "list_tasks", "task_status", "task_result"];

function writePrivate(path: string, content: string): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, content, { mode: 0o600 });
  renameSync(temporary, path);
}

/**
 * Runs the background service that owns the state directory. It outlives MCP
 * clients: an MCP entry point disconnecting never stops it.
 */
export async function runService(paths: StatePaths): Promise<void> {
  secureStateDir(paths);
  let secrets: string[] = [];
  const log = (message: string) => {
    appendFileSync(paths.log, `${new Date().toISOString()} ${redact(message, secrets)}\n`, {
      mode: 0o600,
    });
  };
  const config = () => {
    let loaded;
    try {
      loaded = loadConfig(paths.config);
    } catch (error) {
      if (error instanceof ConfigError) throw new ServiceError("config_invalid", error.message);
      throw error;
    }
    secrets = configSecrets(loaded);
    return loaded;
  };

  try {
    await start(paths, log, config);
  } catch (error) {
    if (error instanceof StoreLockedError) return;
    log(`service failed to start: ${errorOrigin(error)}`);
    throw error;
  }
}

async function start(
  paths: StatePaths,
  log: (message: string) => void,
  config: () => ReturnType<typeof loadConfig>,
): Promise<void> {
  const store = openStore(paths.database);
  const tasks = new TaskService(store, paths, config, log);
  tasks.interruptUnfinished();
  try {
    if (statSync(paths.log).size > maxLogBytes) renameSync(paths.log, `${paths.log}.1`);
  } catch {
    // No log yet.
  }

  const token = randomBytes(32).toString("hex");
  writePrivate(paths.token, token);
  rmSync(paths.socket, { force: true });
  const service = { pid: process.pid, version: metadata.version };
  const server = await serve(
    paths.socket,
    token,
    { service },
    {
      readiness: async (params) => {
        const { project } = (params ?? {}) as { project?: string };
        const report = await checkReadiness({
          paths,
          config: config(),
          ...(project ? { project: resolve(project) } : {}),
          log,
        });
        return { ...report, service: { ...service, node: process.version }, operations };
      },
      start_task: (params, { caller }) => tasks.start(caller, params),
      list_tasks: (params, { caller }) => tasks.list(caller, params),
      task_status: (params, { caller }) => tasks.status(caller, params),
      task_result: (params, { caller }) => tasks.result(caller, params),
    },
    (error) => log(`request failed: ${errorOrigin(error)}`),
  );
  writePrivate(paths.info, JSON.stringify(service));
  log(`service ${metadata.version} started (pid ${process.pid})`);

  const stop = () => {
    log("service stopping");
    server.close();
    rmSync(paths.socket, { force: true });
    store.close();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  process.on("uncaughtException", (error) => {
    log(`uncaught: ${errorOrigin(error)}`);
    process.exit(1);
  });
}
