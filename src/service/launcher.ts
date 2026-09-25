import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { ServiceConnection, ServiceError } from "../ipc.ts";
import { redact } from "../redact.ts";
import { secureStateDir, type StatePaths } from "../state.ts";

const startTimeoutMs = 15_000;

function readToken(paths: StatePaths): string | undefined {
  try {
    return readFileSync(paths.token, "utf8").trim();
  } catch {
    return undefined;
  }
}

function logTail(paths: StatePaths): string {
  try {
    return redact(readFileSync(paths.log, "utf8").trim().split("\n").slice(-5).join("\n"));
  } catch {
    return "";
  }
}

/**
 * Connects to the service that owns the state directory, starting it as a
 * detached process when none is running. Concurrent callers may each start a
 * service; exactly one takes the state database lock, and the rest exit.
 */
export async function connectService(
  paths: StatePaths,
  cliPath: string,
  caller: string,
): Promise<ServiceConnection> {
  secureStateDir(paths);
  const deadline = Date.now() + startTimeoutMs;
  let started = false;
  let lastError: unknown;
  for (;;) {
    const token = readToken(paths);
    if (token) {
      try {
        return await ServiceConnection.open(paths.socket, token, caller);
      } catch (error) {
        lastError = error;
        if (error instanceof ServiceError && error.code === "protocol_mismatch") throw error;
      }
    }
    if (!started) {
      started = true;
      const child = spawn(process.execPath, [cliPath, "service"], {
        detached: true,
        stdio: "ignore",
        env: process.env,
      });
      child.on("error", (error) => (lastError = error));
      child.unref();
    }
    if (Date.now() > deadline) {
      const tail = logTail(paths);
      throw new ServiceError(
        "service_unavailable",
        `The bridge service did not start within ${startTimeoutMs / 1000} s (${(lastError as Error | undefined)?.message ?? "no response"}).${tail ? ` Recent service log:\n${tail}` : ""}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
