import { execFile } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", cwd, ...args], {
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024,
    // Inspection must not rewrite the index as a side effect.
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
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
  // Every staged blob, so a staged edit counts even when the working file is restored.
  for (const entry of (await git(root, "ls-files", "--stage", "-z")).split("\0")) {
    const tab = entry.indexOf("\t");
    if (tab > 0) state.set(`index:${entry.slice(tab + 1)}`, entry.slice(0, tab));
  }
  const status = await git(root, "status", "--porcelain=v1", "-z", "--untracked-files=all");
  const entries = status.split("\0").filter(Boolean);
  const changed: string[] = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    state.set(`worktree:${path}`, code);
    // Directories (such as nested repositories) and symlinks are compared by status only.
    if (isRegularFile(join(root, path))) changed.push(path);
    // Renames and copies are followed by their source path.
    if (code.includes("R") || code.includes("C")) index++;
  }
  // Content hashes catch further edits to files that were already modified.
  for (const [path, hash] of await hashFiles(root, changed)) {
    state.set(`worktree:${path}`, `${state.get(`worktree:${path}`)} ${hash}`);
  }
  return state;
}

function isRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

/** Hashes files in one batch, or one by one when a file cannot be read, skipping those. */
async function hashFiles(root: string, paths: string[]): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  if (paths.length === 0) return hashes;
  try {
    const output = (await git(root, "hash-object", "--", ...paths)).trim().split("\n");
    paths.forEach((path, index) => hashes.set(path, output[index] ?? ""));
  } catch {
    for (const path of paths) {
      const hash = await git(root, "hash-object", "--", path).catch(() => undefined);
      if (hash !== undefined) hashes.set(path, hash.trim());
    }
  }
  return hashes;
}

/** Paths whose index or working state differs between two snapshots, and HEAD if it moved. */
export function changedPaths(before: Map<string, string>, after: Map<string, string>): string[] {
  const keys = new Set([...before.keys(), ...after.keys()]);
  const paths = [...keys]
    .filter((key) => before.get(key) !== after.get(key))
    .map((key) => key.replace(/^(index|worktree):/, ""));
  return [...new Set(paths)].toSorted();
}
