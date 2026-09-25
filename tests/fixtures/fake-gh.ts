#!/usr/bin/env node
// Deterministic stand-in for the GitHub CLI. It keeps pull requests in a JSON
// file in FAKE_GH_DIR, records each call there, and reads branch heads from the
// working directory's `origin` remote, a local repository in tests.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface FakePullRequest {
  number: number;
  headRefName: string;
  title: string;
  state: "OPEN" | "CLOSED" | "MERGED";
}

export interface FakeGitHub {
  pullRequests: FakePullRequest[];
  /** Makes every call fail with this text on stderr. */
  failWith?: string;
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

const git = (...gitArgs: string[]) => execFileSync("git", gitArgs, { encoding: "utf8" }).trim();
const url = (number: number) => `https://github.example/owner/repo/pull/${number}`;
const head = (branch: string) => git("ls-remote", "origin", `refs/heads/${branch}`).split("\t")[0];

if (state.failWith) fail(state.failWith);
const [group, action] = args;
if (group === "pr" && action === "list") {
  const branch = option("--head");
  const fields = (option("--json") ?? "number").split(",");
  const listed = state.pullRequests
    .filter((pr) => branch === undefined || pr.headRefName === branch)
    .map((pr) => {
      const all: Record<string, unknown> = {
        ...pr,
        url: url(pr.number),
        headRefOid: head(pr.headRefName),
      };
      return Object.fromEntries(fields.map((field) => [field, all[field]]));
    });
  console.log(JSON.stringify(listed));
} else if (group === "pr" && action === "create") {
  const branch = option("--head") ?? git("branch", "--show-current");
  const open = state.pullRequests.find((pr) => pr.headRefName === branch && pr.state === "OPEN");
  if (open) fail(`a pull request for branch "${branch}" already exists:\n${url(open.number)}`);
  if (!head(branch)) fail(`you must first push the current branch to a remote`);
  const number = state.pullRequests.length + 1;
  state.pullRequests.push({
    number,
    headRefName: branch,
    title: option("--title") ?? "",
    state: "OPEN",
  });
  writeFileSync(statePath, JSON.stringify(state));
  console.log(url(number));
} else {
  fail(`unknown command ${args.join(" ")}`);
}
