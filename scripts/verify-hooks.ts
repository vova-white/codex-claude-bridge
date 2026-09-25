import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = process.cwd();
const fixture = mkdtempSync(join(tmpdir(), "bridge-hooks-"));
const env: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  XDG_CONFIG_HOME: join(fixture, "user-config"),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Hook Verification",
  GIT_AUTHOR_EMAIL: "hooks@example.invalid",
  GIT_COMMITTER_NAME: "Hook Verification",
  GIT_COMMITTER_EMAIL: "hooks@example.invalid",
};
for (const key of execFileSync("git", ["rev-parse", "--local-env-vars"], { encoding: "utf8" })
  .trim()
  .split("\n"))
  delete env[key];
delete env.HUSKY;
delete env.VP_GIT_HOOKS;
delete env.VITE_GIT_HOOKS;

function git(...args: string[]): string {
  return execFileSync("git", args, {
    cwd: fixture,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}
function tool(...args: string[]): void {
  execFileSync(process.execPath, [join(fixture, "node_modules/vite-plus/bin/vp"), ...args], {
    cwd: fixture,
    env,
    stdio: "pipe",
  });
}
function commit() {
  return spawnSync("git", ["commit", "-m", "test: verify commit checks"], {
    cwd: fixture,
    env,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024,
  });
}
function content(file: string): string {
  return readFileSync(join(fixture, file), "utf8");
}
function write(file: string, value: string): void {
  writeFileSync(join(fixture, file), value);
}

try {
  const files = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean);
  for (const file of files) {
    const target = join(fixture, file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(resolve(root, file), target);
  }
  symlinkSync(join(root, "node_modules"), join(fixture, "node_modules"), "junction");
  git("init", "--template=", "--initial-branch=main");
  tool("hooks", "enable");
  assert.match(git("config", "--get", "core.hooksPath"), /\.vite-hooks/);
  git("add", ".");
  const baseline = commit();
  assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
  assert.match(baseline.stdout + baseline.stderr, /Quality checks passed/);
  console.log("PASS: Git invokes the hook and accepts valid scoped checks.");

  const cases = [
    {
      name: "formatting",
      file: "src/arguments.ts",
      mutate: (value: string) => value + "\nexport const unformatted=1\n",
      format: false,
      evidence: /Format issues found/,
    },
    {
      name: "lint",
      file: "src/cli.ts",
      mutate: (value: string) => value + "\ndebugger;\n",
      format: true,
      evidence: /no-debugger/,
    },
    {
      name: "types",
      file: "src/cli.ts",
      mutate: (value: string) => value + "\nconst broken: string = 1;\nconsole.log(broken);\n",
      format: true,
      evidence: /TS2322/,
    },

    {
      name: "related unit tests",
      file: "src/arguments.ts",
      mutate: (value: string) => value.replace('return "version";', 'return "help";'),
      format: true,
      evidence: /selects version output/,
    },
    {
      name: "unit tests",
      file: "tests/unit/arguments.test.ts",
      mutate: (value: string) => value.replace('toBe("version")', 'toBe("help")'),
      format: true,
      evidence: /selects version output/,
    },
  ];
  for (const scenario of cases) {
    git("reset", "--hard", "HEAD");
    const original = content(scenario.file);
    const changed = scenario.mutate(original);
    assert.notEqual(changed, original, `${scenario.name}: mutation must apply`);
    write(scenario.file, changed);
    if (scenario.format) tool("fmt", "--write", scenario.file);
    git("add", scenario.file);
    write(
      scenario.file,
      content(scenario.file) + "\n// Unstaged content must survive a rejected commit.\n",
    );
    write("README.md", content("README.md") + "\nUnstaged documentation.\n");
    const before = {
      head: git("rev-parse", "HEAD"),
      index: git("write-tree"),
      status: git("status", "--porcelain=v1"),
      file: content(scenario.file),
      readme: content("README.md"),
    };
    const result = commit();
    const output = result.stdout + result.stderr;
    assert.equal(result.error, undefined, `${scenario.name}: ${result.error}`);
    assert.notEqual(result.status, 0, `${scenario.name}: commit unexpectedly passed`);
    assert.match(output, scenario.evidence, output);
    assert.equal(git("rev-parse", "HEAD"), before.head);
    assert.equal(git("write-tree"), before.index);
    assert.equal(git("status", "--porcelain=v1"), before.status);
    assert.equal(content(scenario.file), before.file);
    assert.equal(content("README.md"), before.readme);
    console.log(`PASS: ${scenario.name} blocks Git commit; index and working files are preserved.`);
  }

  git("reset", "--hard", "HEAD");
  write(
    "src/arguments.ts",
    content("src/arguments.ts") + "\n// Verify the scope of a valid source change.\n",
  );
  tool("fmt", "--write", "src/arguments.ts");
  git("add", "src/arguments.ts");
  const stagedSource = git("show", ":src/arguments.ts");
  write("src/arguments.ts", content("src/arguments.ts") + "\ninvalid unstaged source\n");
  const partialSource = content("src/arguments.ts");
  const sourceCommit = commit();
  assert.equal(sourceCommit.status, 0, sourceCommit.stdout + sourceCommit.stderr);
  assert.match(sourceCommit.stdout + sourceCommit.stderr, /test related --run/);
  assert.match(sourceCommit.stdout + sourceCommit.stderr, /Test Files +1 passed/);
  assert.match(sourceCommit.stdout + sourceCommit.stderr, /tsc --noEmit/);
  assert.doesNotMatch(
    sourceCommit.stdout + sourceCommit.stderr,
    /build-check|scripts\/e2e|test run tests\/integration/,
  );
  assert.equal(git("show", "HEAD:src/arguments.ts"), stagedSource);
  assert.equal(content("src/arguments.ts"), partialSource);
  console.log(
    "PASS: related unit tests and full typecheck accept staged source while preserving unstaged edits.",
  );

  for (const file of ["vite.config.ts", "tests/integration/cli.test.ts", "tests/e2e/cli.e2e.ts"]) {
    git("reset", "--hard", "HEAD");
    const original = content(file);
    const changed =
      file === "vite.config.ts"
        ? original.replace('entry: ["src/cli.ts"]', 'entry: ["src/missing.ts"]')
        : original.replace("toBe(metadata.version)", 'toBe(metadata.version + "-wrong")');
    assert.notEqual(changed, original);
    write(file, changed);
    tool("fmt", "--write", file);
    git("add", file);
    const result = commit();
    const output = result.stdout + result.stderr;
    assert.equal(result.status, 0, output);
    assert.match(output, /tsc --noEmit/);
    assert.doesNotMatch(output, /build-check|scripts\/e2e|vp test/);
    console.log(
      `PASS: ${file} receives static checks; build and integration/E2E execution belongs to CI.`,
    );
    // Restore the fixture's last valid revision before the next independent case.
    git("reset", "--hard", "HEAD~1");
  }

  git("reset", "--hard", "HEAD");
  write("README.md", content("README.md") + "\nHook scope verification.\n");
  tool("fmt", "--write", "README.md");
  git("add", "README.md");
  write("src/cli.ts", content("src/cli.ts") + "\nthis is invalid unstaged source\n");
  const dirtySource = content("src/cli.ts");
  const documentation = commit();
  assert.equal(documentation.status, 0, documentation.stdout + documentation.stderr);
  assert.match(documentation.stdout + documentation.stderr, /Documentation checks passed/);
  assert.doesNotMatch(
    documentation.stdout + documentation.stderr,
    /build-check|test run|tsc --noEmit/,
  );
  assert.equal(content("src/cli.ts"), dirtySource);
  console.log(
    "PASS: documentation-only commit skips unrelated checks and preserves unstaged source.",
  );
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
