import { randomBytes } from "node:crypto";
import { appendFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { checkReadiness } from "../claude/readiness.ts";
import { ConfigError, configSecrets, loadConfig } from "../config.ts";
import { serve, ServiceError } from "../ipc.ts";
import { redact } from "../redact.ts";
import { secureStateDir, type StatePaths } from "../state.ts";
import { openStore, StoreLockedError } from "./store.ts";
import metadata from "../../package.json" with { type: "json" };

const maxLogBytes = 1024 * 1024;

/** Operations the service implements. Only these are advertised to Codex. */
export const operations = ["readiness"];

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
    const loaded = loadConfig(paths.config);
    secrets = configSecrets(loaded);
    return loaded;
  };

  try {
    await start(paths, log, config);
  } catch (error) {
    if (error instanceof StoreLockedError) return;
    log(`service failed to start: ${(error as Error).stack ?? String(error)}`);
    throw error;
  }
}

async function start(
  paths: StatePaths,
  log: (message: string) => void,
  config: () => ReturnType<typeof loadConfig>,
): Promise<void> {
  const store = openStore(paths.database);
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
        let loaded;
        try {
          loaded = config();
        } catch (error) {
          if (error instanceof ConfigError) throw new ServiceError("config_invalid", error.message);
          throw error;
        }
        const report = await checkReadiness({
          paths,
          config: loaded,
          ...(project ? { project: resolve(project) } : {}),
          log,
        });
        return { ...report, service: { ...service, node: process.version }, operations };
      },
    },
    (error) => log(`request failed: ${(error as Error).stack ?? String(error)}`),
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
    log(`uncaught: ${error.stack ?? String(error)}`);
    process.exit(1);
  });
}
