import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { redact } from "./redact.ts";
import { hasUncommittedChanges, resolveCommit } from "./workspace.ts";

const run = promisify(execFile);

/** How a writing task delivers its commits: kept in the worktree, or pushed as a pull request. */
export const publishModes = ["none", "pull_request"] as const;

/** Why the bridge could not establish part of a task branch's remote state. */
export type RemoteProblem = "no_remote" | "remote_unavailable" | "github_unavailable";

export interface PullRequest {
  number: number;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  headRevision: string;
}

/**
 * A task branch as the bridge found it locally and on its remote. `undefined`
 * pushedRevision or pullRequest means the check could not tell; `null` means
 * there is none.
 */
export interface RemoteState {
  remote: string;
  repository?: string;
  revision: string | undefined;
  uncommitted: boolean;
  pushedRevision?: string | null;
  pullRequest?: PullRequest | null;
  problems: RemoteProblem[];
}

const pullRequests = z.array(
  z.object({
    number: z.number().int().positive(),
    url: z
      .string()
      .max(500)
      .regex(/^https:\/\/\S+$/),
    state: z.enum(["OPEN", "CLOSED", "MERGED"]),
    headRefOid: z.string().regex(/^[0-9a-f]{40,64}$/),
  }),
);

async function command(
  file: string,
  cwd: string,
  args: string[],
  signal?: AbortSignal,
  env: Record<string, string> = {},
): Promise<string> {
  const { stdout } = await run(file, args, {
    cwd,
    ...(signal ? { signal } : {}),
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
    // A check must fail rather than wait for credentials nobody can type.
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1", ...env },
  });
  return stdout;
}

/** The first value Git has for one of these configuration keys, in order. */
async function firstConfigured(worktree: string, keys: string[]): Promise<string | undefined> {
  for (const key of keys) {
    const value = await command("git", worktree, ["config", "--get", key]).catch(() => "");
    if (value.trim()) return value.trim();
  }
  return undefined;
}

/**
 * Reads the task branch's remote state: the revision its push destination
 * holds (`git ls-remote`) and its pull request (`gh pr list`), which is asked
 * for even when the branch is gone from the remote, as after a merge. Output is
 * parsed into known fields; the tools' error text is never kept.
 */
export async function remoteState(
  worktree: string,
  branch: string,
  secrets: readonly string[],
  signal?: AbortSignal,
): Promise<RemoteState> {
  // The remote `git push` uses for the branch, as Git chooses it.
  const remote =
    (await firstConfigured(worktree, [
      `branch.${branch}.pushRemote`,
      "remote.pushDefault",
      `branch.${branch}.remote`,
    ])) ?? "origin";
  const state: RemoteState = {
    remote,
    revision: await resolveCommit(worktree, `refs/heads/${branch}`),
    uncommitted: await hasUncommittedChanges(worktree).catch(() => false),
    problems: [],
  };
  const url = await command("git", worktree, ["remote", "get-url", "--push", remote]).catch(
    () => undefined,
  );
  if (url === undefined) {
    state.problems.push("no_remote");
    return state;
  }
  state.repository = redact(url.trim(), secrets);
  // A separate push URL is where the branch was published, not the fetch URL.
  // Git reads it from the environment as a temporary remote, since a URL may
  // hold credentials that must stay out of command lines.
  const fetchUrl = await command("git", worktree, ["remote", "get-url", remote]).catch(() => "");
  const pushTarget = "codex-claude-bridge-push";
  const [target, env] =
    fetchUrl.trim() === url.trim()
      ? [remote, {}]
      : [
          pushTarget,
          {
            GIT_CONFIG_COUNT: "1",
            GIT_CONFIG_KEY_0: `remote.${pushTarget}.url`,
            GIT_CONFIG_VALUE_0: url.trim(),
          },
        ];
  try {
    const listed = await command(
      "git",
      worktree,
      ["ls-remote", target, `refs/heads/${branch}`],
      signal,
      env,
    );
    const line = listed.split("\n").find((entry) => entry.endsWith(`\trefs/heads/${branch}`));
    const revision = line?.split("\t")[0] ?? "";
    state.pushedRevision = /^[0-9a-f]{40,64}$/.test(revision) ? revision : null;
  } catch {
    state.problems.push("remote_unavailable");
  }
  try {
    const output = await command(
      "gh",
      worktree,
      [
        "pr",
        "list",
        "--head",
        branch,
        "--state",
        "all",
        "--json",
        "number,url,state,headRefOid",
        "--limit",
        "20",
      ],
      signal,
    );
    const found = pullRequests.parse(JSON.parse(output));
    // An open pull request is the one to update; otherwise the latest one.
    const chosen =
      found.find((pr) => pr.state === "OPEN") ?? found.toSorted((a, b) => b.number - a.number)[0];
    state.pullRequest = chosen
      ? {
          number: chosen.number,
          url: chosen.url,
          state: chosen.state,
          headRevision: chosen.headRefOid,
        }
      : null;
  } catch {
    state.problems.push("github_unavailable");
  }
  return state;
}

/** A task's publication as the bridge last recorded it. */
export interface Publication {
  remote: string;
  repository: string | null;
  branch: string;
  revision: string | null;
  uncommitted: boolean;
  pushedRevision: string | null;
  pullRequest: PullRequest | null;
  problems: RemoteProblem[];
  checkedAt: string;
}

/**
 * The publication section of results and task status, with the concerns the
 * bridge derives from it: each has a code, a message, and an action.
 */
export function publicationReport(publication: Publication, worktree: string) {
  const { remote, branch, revision, pushedRevision, pullRequest } = publication;
  const push = `Send a follow-up asking Claude to push, or push it yourself with \`git -C ${worktree} push ${remote} ${branch}\`.`;
  const concerns: { code: string; message: string; action?: string }[] = [];
  const problems = new Set(publication.problems);
  if (problems.has("no_remote")) {
    concerns.push({
      code: "no_remote",
      message: `The repository has no remote named ${remote}, so ${branch} cannot be published.`,
      action: `Add the remote, then ${push.charAt(0).toLowerCase()}${push.slice(1)}`,
    });
  }
  if (problems.has("remote_unavailable")) {
    concerns.push({
      code: "remote_unavailable",
      message: `The bridge could not read ${branch} from ${remote}; the pushed revision shown is from an earlier check, if any.`,
      action: `Check access with \`git -C ${worktree} ls-remote ${remote}\`.`,
    });
  }
  if (problems.has("github_unavailable")) {
    concerns.push({
      code: "github_unavailable",
      message: `The bridge could not list pull requests for ${branch} with the GitHub CLI; the pull request shown is from an earlier check, if any.`,
      action: `Check that the GitHub CLI is installed and signed in for the bridge service (\`gh auth status\`), then run \`gh pr list --head ${branch}\` in ${worktree}.`,
    });
  }
  if (!problems.has("no_remote") && !problems.has("remote_unavailable")) {
    if (pushedRevision === null && pullRequest) {
      concerns.push({
        code: "branch_not_on_remote",
        message: `${branch} is no longer on ${remote}; its pull request #${pullRequest.number} is ${pullRequest.state} with head ${pullRequest.headRevision}.`,
        ...(revision === pullRequest.headRevision ? {} : { action: push }),
      });
    } else if (pushedRevision === null) {
      concerns.push({
        code: "not_pushed",
        message: `${branch} is not on ${remote}; its commits exist only in the task worktree.`,
        action: push,
      });
    } else if (revision !== pushedRevision) {
      concerns.push({
        code: "unpushed_commits",
        message: `The task worktree has ${branch} at ${revision}, but ${remote} has ${pushedRevision}.`,
        action: push,
      });
    }
  }
  if (publication.uncommitted) {
    concerns.push({
      code: "uncommitted_changes",
      message: "The task worktree has uncommitted changes, which are not published.",
      action: `Inspect them with \`git -C ${worktree} status\`; send a follow-up asking Claude to commit and push them if they belong to the task.`,
    });
  }
  if (pushedRevision !== null && pullRequest === null && !problems.has("github_unavailable")) {
    concerns.push({
      code: "no_pull_request",
      message: `No pull request exists for ${branch}.`,
      action: `Send a follow-up asking Claude to open it, or open it yourself with \`gh pr create --head ${branch}\`.`,
    });
  }
  if (pullRequest?.state === "CLOSED") {
    concerns.push({
      code: "pull_request_closed",
      message: `Pull request #${pullRequest.number} for ${branch} is closed without being merged.`,
    });
  }
  return {
    mode: "pull_request",
    repository: publication.repository,
    remote,
    branch,
    revision,
    pushedRevision,
    pushed: revision !== null && revision === pushedRevision,
    pullRequest,
    checkedAt: publication.checkedAt,
    concerns,
  };
}

export type PublicationReport = ReturnType<typeof publicationReport>;
