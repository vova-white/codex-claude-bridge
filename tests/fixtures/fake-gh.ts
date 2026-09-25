#!/usr/bin/env node
// Deterministic stand-in for the GitHub CLI. It keeps pull requests in a JSON
// file in FAKE_GH_DIR, records each call there, and reads branch heads from
// where the working directory's `origin` pushes, a local repository in tests.
// Like GitHub, a pull request keeps its last head after its branch is deleted.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface FakePullRequest {
  number: number;
  headRefName: string;
  title: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  headRefOid: string;
}

export interface FakeGitHub {
  pullRequests: FakePullRequest[];
  /** Makes every call fail with this text on stderr. */
  failWith?: string;
  /** Holds `pr list` until this file exists in FAKE_GH_DIR. */
  listWaitsFor?: string;
}

const dir = process.env.FAKE_GH_DIR ?? process.cwd();
const statePath = join(dir, "gh-state.json");
const args = process.argv.slice(2);
appendFileSync(join(dir, "gh-calls.jsonl"), `${JSON.stringify({ args, cwd: process.cwd() })}\n`);
const state: FakeGitHub = existsSync(statePath)
  ? JSON.parse(readFileSync(statePath, "utf8"))
  : { pullRequests: [] };

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function option(name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

const git = (gitArgs: string[], env: Record<string, string> = {}) =>
  execFileSync("git", gitArgs, { encoding: "utf8", env: { ...process.env, ...env } }).trim();
const url = (number: number) => `https://github.example/owner/repo/pull/${number}`;
// The push URL goes through the environment, as the bridge passes it, so tests
// can check that no command line holds it.
const head = (branch: string) =>
  git(["ls-remote", "fake-gh-push", `refs/heads/${branch}`], {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "remote.fake-gh-push.url",
    GIT_CONFIG_VALUE_0: git(["remote", "get-url", "--push", "origin"]),
  }).split("\t")[0] ?? "";

if (state.failWith) fail(state.failWith);
const [group, action] = args;
if (group === "pr" && action === "list") {
  while (state.listWaitsFor && !existsSync(join(dir, state.listWaitsFor))) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  const branch = option("--head");
  const fields = (option("--json") ?? "number").split(",");
  const listed = state.pullRequests
    .filter((pr) => branch === undefined || pr.headRefName === branch)
    .map((pr) => {
      const all: Record<string, unknown> = {
        ...pr,
        url: url(pr.number),
        headRefOid: head(pr.headRefName) || pr.headRefOid,
      };
      return Object.fromEntries(fields.map((field) => [field, all[field]]));
    });
  console.log(JSON.stringify(listed));
} else if (group === "pr" && action === "create") {
  const branch = option("--head") ?? git(["branch", "--show-current"]);
  const open = state.pullRequests.find((pr) => pr.headRefName === branch && pr.state === "OPEN");
  if (open) fail(`a pull request for branch "${branch}" already exists:\n${url(open.number)}`);
  const headRefOid = head(branch);
  if (!headRefOid) fail(`you must first push the current branch to a remote`);
  const number = state.pullRequests.length + 1;
  state.pullRequests.push({
    number,
    headRefName: branch,
    title: option("--title") ?? "",
    state: "OPEN",
    headRefOid,
  });
  writeFileSync(statePath, JSON.stringify(state));
  console.log(url(number));
} else {
  fail(`unknown command ${args.join(" ")}`);
}
