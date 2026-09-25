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

/** Whether the checkout has uncommitted changes, including untracked files. */
export async function hasUncommittedChanges(root: string): Promise<boolean> {
  return (await git(root, "status", "--porcelain=v1", "--untracked-files=normal")).trim() !== "";
}

/** The commit a reference names, or undefined when it names none. */
export async function resolveCommit(root: string, reference: string): Promise<string | undefined> {
  if (reference.startsWith("-")) return undefined;
  try {
    return (await git(root, "rev-parse", "--verify", "--quiet", `${reference}^{commit}`)).trim();
  } catch {
    return undefined;
  }
}

/** GitFlow branch prefixes a writing task may use. */
export const branchTypes = ["feature", "bugfix", "hotfix", "release", "support"] as const;

/** A task branch name: GitFlow prefix, a slug of the assignment, and part of the task ID. */
export function taskBranch(type: string, assignment: string, taskId: string): string {
  const slug = assignment
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .slice(0, 6)
    .join("-")
    .slice(0, 40)
    .replace(/-+$/, "");
  const suffix = taskId.replace(/^task_/, "").slice(0, 8);
  return `${type}/${slug ? `${slug}-` : ""}${suffix}`;
}

/**
 * Adds a worktree on a new branch at the baseline. A failed attempt leaves no
 * worktree registration, directory, or new branch behind.
 */
export async function addWorktree(
  root: string,
  path: string,
  branch: string,
  baseline: string,
): Promise<void> {
  try {
    await git(root, "worktree", "add", "--quiet", "-b", branch, path, baseline);
  } catch (error) {
    await git(root, "worktree", "remove", "--force", path).catch(() => "");
    await git(root, "worktree", "prune").catch(() => "");
    const tip = (await resolveCommit(root, `refs/heads/${branch}`)) ?? "";
    if (tip === baseline) await git(root, "branch", "-D", branch).catch(() => "");
    throw error;
  }
}

/** Commits on the branch since the baseline and files that differ from it, committed or not. */
export async function worktreeChanges(
  path: string,
  baseline: string,
): Promise<{ commits: { sha: string; subject: string }[]; changedFiles: string[] }> {
  const log = await git(path, "log", "--format=%H%x09%s", `${baseline}..HEAD`);
  const commits = log
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha = "", ...subject] = line.split("\t");
      return { sha, subject: subject.join("\t") };
    });
  // Working files, the index, and untracked files can each differ from the baseline.
  const working = await git(path, "diff", "--name-only", "-z", baseline);
  const staged = await git(path, "diff", "--cached", "--name-only", "-z", baseline);
  const untracked = await git(path, "ls-files", "--others", "--exclude-standard", "-z");
  const changedFiles = [
    ...new Set([working, staged, untracked].flatMap((list) => list.split("\0")).filter(Boolean)),
  ].toSorted();
  return { commits, changedFiles };
}

/** Paths of the worktrees Git has registered for the repository, including missing ones. */
export async function registeredWorktrees(root: string): Promise<string[]> {
  return (await git(root, "worktree", "list", "--porcelain"))
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}

/**
 * How many commits of a branch no other branch, tag, remote-tracking ref, or
 * the checkout's HEAD contains: the work that deleting the branch would lose.
 */
export async function unintegratedCommits(root: string, branch: string): Promise<number> {
  const count = await git(
    root,
    "rev-list",
    "--count",
    `refs/heads/${branch}`,
    "--not",
    `--exclude=${branch}`,
    "--branches",
    "--remotes",
    "--tags",
    "HEAD",
  );
  return Number(count.trim());
}

/** Removes a registered worktree; without `force`, Git refuses one with changes. */
export async function removeWorktree(root: string, path: string, force: boolean): Promise<void> {
  await git(root, "worktree", "remove", ...(force ? ["--force"] : []), path);
}

/** Deletes a local branch whatever it contains; the caller decides that it may go. */
export async function deleteBranch(root: string, branch: string): Promise<void> {
  await git(root, "branch", "--quiet", "-D", branch);
}
