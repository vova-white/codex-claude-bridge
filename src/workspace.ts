import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", cwd, ...args], {
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

/** The root of the Git checkout containing `path`, or undefined when there is none. */
export async function repositoryRoot(path: string): Promise<string | undefined> {
  try {
    return realpathSync((await git(path, "rev-parse", "--show-toplevel")).trim());
  } catch {
    return undefined;
  }
}

/** A comparable record of a checkout's HEAD, index, and working files. */
export async function checkoutState(root: string): Promise<Map<string, string>> {
  const state = new Map<string, string>();
  state.set("HEAD", (await git(root, "rev-parse", "HEAD").catch(() => "")).trim());
  const status = await git(root, "status", "--porcelain=v1", "-z", "--untracked-files=all");
  const entries = status.split("\0").filter(Boolean);
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    const code = entry.slice(0, 2);
    state.set(entry.slice(3), code);
    // Renames and copies are followed by their source path.
    if (code.includes("R") || code.includes("C")) index++;
  }
  const changed = [...state.keys()].filter(
    (path) => path !== "HEAD" && existsSync(join(root, path)),
  );
  if (changed.length > 0) {
    // Content hashes catch further edits to files that were already modified.
    const hashes = await git(root, "hash-object", "--", ...changed).catch(() => "");
    hashes
      .trim()
      .split("\n")
      .forEach((hash, index) => {
        const path = changed[index];
        if (path) state.set(path, `${state.get(path)} ${hash}`);
      });
  }
  return state;
}

/** Paths whose state differs between two snapshots, including a moved HEAD. */
export function changedPaths(before: Map<string, string>, after: Map<string, string>): string[] {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((path) => before.get(path) !== after.get(path)).toSorted();
}
