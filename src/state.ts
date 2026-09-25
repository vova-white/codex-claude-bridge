import { chmodSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Files owned by one bridge installation. One service owns a state directory at a time. */
export interface StatePaths {
  dir: string;
  config: string;
  database: string;
  socket: string;
  token: string;
  info: string;
  log: string;
  claudeMcpConfig: string;
}

// Unix domain socket paths are limited to about 104-108 bytes depending on the platform.
const maxSocketPath = 100;

export function statePaths(env: NodeJS.ProcessEnv = process.env): StatePaths {
  const dir =
    env.CODEX_CLAUDE_BRIDGE_HOME ||
    join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "codex-claude-bridge");
  return {
    dir,
    config: join(dir, "config.json"),
    database: join(dir, "state.db"),
    socket: join(dir, "service.sock"),
    token: join(dir, "service.token"),
    info: join(dir, "service.json"),
    log: join(dir, "service.log"),
    claudeMcpConfig: join(dir, "claude-mcp.json"),
  };
}

/**
 * Creates the state directory, or tightens it, so that only the current user can
 * reach the service socket, token, and task state.
 */
export function secureStateDir(paths: StatePaths): void {
  if (paths.socket.length > maxSocketPath) {
    throw new Error(
      `State directory path is too long for a local socket: ${paths.dir}. Set CODEX_CLAUDE_BRIDGE_HOME to a shorter directory.`,
    );
  }
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  const stats = statSync(paths.dir);
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    throw new Error(`State directory ${paths.dir} belongs to another user.`);
  }
  if ((stats.mode & 0o077) !== 0) chmodSync(paths.dir, 0o700);
}
