import { readFileSync } from "node:fs";

/**
 * A Claude Code process the bridge spawned, identified across PID reuse: its
 * PID and, where the platform reports them (Linux `/proc`), the boot it ran in
 * and its start time. `start` is null elsewhere, and the process can then never
 * be proven to be the one the bridge spawned.
 */
export interface ProcessIdentity {
  pid: number;
  start: string | null;
}

/**
 * What a service found of a process its predecessor spawned. `ended`: no
 * process with that identity exists. `stopped`: it still ran, uncontrolled
 * since the service that owned its stdio died, and was ended through its PID.
 * `unknown`: the bridge cannot prove whether it still runs, because the
 * platform does not report start times or it survived SIGKILL.
 */
export type ProcessRecovery = "ended" | "stopped" | "unknown";

const stopGraceMs = 2_000;

/** The current boot's identifier, or undefined where the platform does not report one. */
export function bootId(): string | undefined {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The state and start time of a process from `/proc/<pid>/stat` (fields 3 and
 * 22), or undefined when no such process exists or `/proc` is unavailable. The
 * command name in field 2 may contain spaces and parentheses, so fields are
 * counted from the last `)`.
 */
function procStat(pid: number): { state: string; start: string } | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const [state, start] = [fields[0], fields[19]];
    return state && start ? { state, start } : undefined;
  } catch {
    return undefined;
  }
}

/** Identifies a process just spawned, while it cannot have been reaped yet. */
export function processIdentity(pid: number): ProcessIdentity {
  const boot = bootId();
  const stat = procStat(pid);
  return { pid, start: boot && stat ? `${boot}:${stat.start}` : null };
}

/** Whether a process with this identity exists and has not exited; undefined when it cannot be told. */
function running(identity: ProcessIdentity): boolean | undefined {
  if (identity.start === null) {
    try {
      process.kill(identity.pid, 0);
      return undefined; // Some process has the PID; it may not be the one spawned.
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH" ? false : undefined;
    }
  }
  const stat = procStat(identity.pid);
  // A zombie has exited and only waits for its new parent to reap it.
  return stat !== undefined && stat.state !== "Z" && `${bootId()}:${stat.start}` === identity.start;
}

async function exitsWithin(identity: ProcessIdentity, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (running(identity)) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}

/**
 * Ends a process a previous service spawned, if it provably still runs: only a
 * process whose PID and start time both match the record is signalled, first
 * with SIGTERM and after a grace period with SIGKILL. Persisted running status
 * alone is never taken as proof either way.
 */
export async function reclaimProcess(identity: ProcessIdentity): Promise<ProcessRecovery> {
  if (running(identity) === undefined) return "unknown";
  let signalled = false;
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    // Checked right before signalling, so a PID reused meanwhile is never hit.
    if (!running(identity)) return signalled ? "stopped" : "ended";
    try {
      process.kill(identity.pid, signal);
    } catch {
      if (running(identity)) return "unknown";
      return signalled ? "stopped" : "ended";
    }
    signalled = true;
    if (await exitsWithin(identity, stopGraceMs)) return "stopped";
  }
  return "unknown";
}
