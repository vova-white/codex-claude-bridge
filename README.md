# Codex to Claude bridge

A local Codex-to-Claude delegation bridge: a personal Codex plugin with a delegation skill and a stdio MCP entry point, backed by a background service that runs Claude Code through the Claude Agent SDK with your existing Claude Code login. This release checks readiness and runs read-only delegated tasks on a shared checkout (optionally with nested read-only agents) and writing tasks in isolated Git worktrees, with bounded waits, cursor-based progress reads, follow-ups to the same Claude session, and cancellation; publishing task pull requests is not implemented yet.

## Setup

Use Node.js **24.21.0**, Bun **1.4.2** as the package manager, and Git **2.32+**. Node runs the application, development scripts, and both test runners. Bun only manages dependencies. [ADR 0003](docs/adr/0003-node-runtime-and-bun-package-management.md) supersedes the Bun runtime and `bun:sqlite` choices in [issue #1](https://github.com/vova-white/codex-claude-bridge/issues/1).

Install the pinned runtimes using your version manager or the official [Node distribution](https://nodejs.org/dist/v24.21.0/) and [Bun installer](https://bun.sh/docs/installation). An existing global Vite+ installation respects `.node-version` and `packageManager`; it is optional. The project installs Vite+ locally.

```sh
bun install --frozen-lockfile
bun run dev
```

Commit `package.json` and `bun.lock` together. Direct dependency versions are exact; use `--frozen-lockfile` for fresh clones and CI. Vite+ **1.0.0-rc.0** is a release candidate and bundles Vitest 5.0.1, Oxlint, Oxfmt, and tsdown. Type checking uses the stable **TypeScript 7.0.2 native Go compiler**, whose released command is `tsc` (previously `tsgo`). Neither Node's TypeScript execution nor the bundler checks types.

`trustedDependencies: []` disables Bun's default dependency-script allowlist. The selected dependencies install without trusted dependency scripts or browser downloads. The repository's own `prepare` script still runs and installs the Vite+ hook dispatcher via `vp config --no-agent`. If installation used `--ignore-scripts`, run `bun run hooks:install` explicitly. Review any new dependency that requires an installation script before adding its name to `trustedDependencies`; do not broadly trust all packages.

## Install the Codex plugin

Requirements: Node.js 24.21.0 on the `PATH` that Codex uses, Claude Code signed in with your Claude subscription (`claude`, then `/login`), and Git 2.32+. Build the plugin bundle from a checkout, then register the checkout as a local plugin marketplace:

```sh
bun install --frozen-lockfile
bun run build:plugin
codex plugin marketplace add /path/to/codex-claude-bridge
codex plugin add claude-bridge@codex-claude-bridge
```

Codex copies the plugin, including the bundle in `plugins/claude-bridge/dist/`, into its plugin cache. After rebuilding, run `codex plugin remove claude-bridge@codex-claude-bridge` and add it again. The plugin provides the `claude-delegation` skill and the `claude_bridge` MCP server; ask Codex to check Claude readiness to verify the installation.

## Architecture and state

Codex launches `node dist/cli.mjs mcp` from the plugin. That MCP entry point keeps no state: it connects to the bridge service over a Unix socket in the state directory, starting `cli.mjs service` as a detached process when none is running. Every connection must present the random token the service writes to `service.token`. The state directory is private to the user (mode 0700), and the service holds an exclusive lock on its SQLite database ([ADR 0004](docs/adr/0004-node-sqlite-and-exclusive-state-ownership.md)), so concurrent MCP clients share one service per state directory. The service keeps running when Codex exits.

The state directory is `$CODEX_CLAUDE_BRIDGE_HOME`, or `$XDG_STATE_HOME/codex-claude-bridge` (default `~/.local/state/codex-claude-bridge`). It contains `state.db`, `service.sock`, `service.token`, `service.json` (PID and version), `service.log` (bridge-composed diagnostics, rotated at 1 MB), and the optional `config.json`:

| Key                | Meaning                                                                     |
| ------------------ | --------------------------------------------------------------------------- |
| `claudeExecutable` | Absolute path to Claude Code when `claude` is not on the service `PATH`     |
| `claudeConfigDir`  | Separate Claude Code configuration directory, passed as `CLAUDE_CONFIG_DIR` |
| `mcpServers`       | MCP servers Claude may use, in Claude Code's format                         |

The service runs Claude Code with its own environment and the user's Claude Code settings. Readiness reports the credential source Claude Code uses and never accepts an API key or a third-party provider as the subscription. Configured MCP servers reach Claude Code through a private file (mode 0600), not the command line. Codex's own tools and connectors are not available to Claude.

Readiness results, the `error` of failed task executions, and `service.log` contain only diagnostics the bridge composes from known fields: problem codes and failure reasons, configured MCP server names, the statuses Claude Code reports for them, failure categories the bridge determines itself (timeout, executable not runnable, the exit code or signal of the Claude Code process it spawned, the assistant error code and result subtype Claude Code reports), the subscription reset time, known account values, model identifiers, and actions. Error text from Claude Code, the Agent SDK, or MCP servers, including stderr, result text, and MCP connection errors, is never copied there, so credentials it may quote cannot leak in any encoding. To see a full error, run `claude` in a terminal: inspect `/mcp` for an integration, or run it in the project and `/resume` the session a failed task reports. Pattern-based redaction remains only as a backstop for the bridge's own messages and for task results; it carries no guarantee.

A writing task (`mode: write`) gets its own worktree under `worktrees/<task>` in the state directory, on a GitFlow task branch created from a committed baseline before any execution runs. A dirty parent checkout is refused unless the caller names the baseline explicitly. The worktree, branch, and changes are kept after completion, failure, and cancellation; nothing deletes them automatically.

Delegated tasks are stored in `state.db` with their executions, provider session references, and results. Each task belongs to a project (the Git root realpath) and a logical caller: `$CODEX_CLAUDE_BRIDGE_CALLER`, default `codex`, which the plugin forwards from Codex's environment. A request key identifies a start request within that scope, so retries return the existing task. A task runs in the service, not the MCP connection, and continues when Codex disconnects. Before sending the brief, the service checks that the Claude Code session uses a verified subscription login and offers the requested model. When a new service starts, executions left running by its predecessor are reported as `interrupted`.

A task's executions run one at a time: a follow-up is a new execution that resumes the task's Claude session (`--resume`) after the active execution ends, and fails as `session_unavailable` rather than starting a new conversation when Claude Code cannot resume it. Cancellation stops the running Claude Code process, which the service spawns itself so it can confirm the process exited (escalating to `SIGKILL` after a grace period), and cancels queued follow-ups.

Claude may start nested agents through Claude Code's Agent tool. The read-only profile disables the edit tools with session deny rules, which Claude Code (verified in 2.1.282) applies to every nested agent's tools and permission checks, whatever its definition lists. The adapter records the nested agents Claude Code reports (`task_started`, `task_progress`, `task_notification`) per execution. A successful result that arrives while some of them still run leaves the execution `running` with `reason: waiting_for_children`: Claude Code runs another turn when a nested agent finishes, and the execution completes with the first result after all have ended. If Claude Code exits first, the execution fails. Nothing bounds a nested agent that never ends except cancellation, which asks Claude Code to stop each running nested agent (`stop_task`), waits briefly for it to report them stopped, and then ends the process. In-process agents end with the process; work they started outside it is not controlled, and the cancel response discloses nested agents whose stop was not reported.

Each execution's progress (status changes, Claude's messages, tool calls, nested agents, and the final summary) is stored as numbered events for `read_output`. Diagnostics retention is bounded separately from results: an event keeps at most 16,000 characters, and an execution keeps its newest 2,000 events. A `wait_task` call lasts at most 300 s, below the plugin's 600 s MCP tool timeout.

To stop the service, send `SIGTERM` to the PID in `service.json`. Running tasks are then reported as interrupted.

## Commands

Use `bun run <name>` to invoke these package scripts. They run Node or the local Vite+ CLI; `bun test` is a different runner and is not used here.

| Script                           | Purpose                                                                 |
| -------------------------------- | ----------------------------------------------------------------------- |
| `dev`                            | Run the TypeScript CLI with Node watch mode                             |
| `start`                          | Run `dist/cli.mjs` after a build                                        |
| `typecheck`                      | Strict native TypeScript checking of source, scripts, tests, and config |
| `lint`                           | Oxlint; warnings fail the command                                       |
| `format`                         | Apply Oxfmt formatting, including Markdown                              |
| `format:check`                   | Verify formatting without fixes                                         |
| `build`                          | Bundle the CLI and its dependencies into `dist/cli.mjs`                 |
| `build:plugin`                   | Bundle the CLI into the plugin directory for installation in Codex      |
| `build:check`                    | Build into a temporary directory, check syntax, and execute the bundle  |
| `test`                           | All Vitest unit and integration tests                                   |
| `test:unit` / `test:integration` | One Vitest test category                                                |
| `test:e2e`                       | Build a fresh temporary bundle and run Playwright process tests         |
| `check`                          | Formatting, lint, types, build verification, Vitest, then Playwright    |
| `hooks:install`                  | Install or refresh the Git hook dispatcher                              |
| `hooks:check`                    | Verify real Git commits in a disposable repository                      |

The CLI accepts `--help`, `--version`, `mcp` (the stdio MCP entry point), and `service` (the background service, normally started by `mcp`). Unsupported invocations return exit code 2 with a diagnostic on stderr. For example: `bun run start --version` after `bun run build`.

## Test boundaries

- `tests/unit/**/*.test.ts`: argument parsing, Claude Code version compatibility, and credential redaction.
- `tests/integration/**/*.test.ts`: the public MCP boundary. `tests/support/bridge.ts` gives each test a temporary state directory and launches the real MCP entry point and background service as subprocesses, with real SQLite. `tests/fixtures/fake-claude.ts` replaces the Claude Code executable: it speaks the Agent SDK's stream-json control protocol and follows a per-test scenario, so the real SDK and adapter run without credentials or model calls.
- `tests/e2e/**/*.e2e.ts`: Playwright Test launches the built CLI outside the source checkout, and runs the plugin as Codex installs it: copied without `node_modules`, launched from its `.mcp.json`.

Vitest and Playwright have separate discovery patterns. Full suites fail when no tests are found, focused tests are forbidden, and retries are disabled for E2E. There are no browser fixtures, so `playwright install` and OS browser libraries are unnecessary. If actual browser behavior is added later, document the required browser and install it explicitly in local setup and CI.

All automated tests work without Claude credentials, model calls, or GitHub mutations. Tests stop the service processes they start; a test's state directory is never the installed bridge's.

## Commit checks

Vite+ manages `.vite-hooks/pre-commit`; no Husky or separate lint-staged package is needed. The hook exports the Git index to a temporary directory and checks that snapshot, sharing the installed `node_modules`. It does not stash, format, stage, or rewrite working files. Partially staged changes are checked as they will appear in the commit. Build and E2E outputs are temporary and cleaned up.

The ordered pre-commit policy is:

1. Verify formatting of staged supported files and lint staged JS/TS files, without fixes.
2. For changes beyond Markdown, check the entire TypeScript project.
3. Run changed unit test files and unit tests related to changed source files through static imports.

The hook does not build or run integration/E2E suites, including when dependency metadata or shared configuration changes. Markdown-only changes require only formatting. Deleted files are excluded from file-based commands; remaining code is still type checked. Related test selection may legitimately be empty; full suites never accept an empty test set. Static imports do not capture subprocess, filesystem, or all dynamic dependencies.

During development, run focused tests for the behavior and consumers affected by the change. For service/process boundaries, select the relevant integration or E2E scenarios explicitly. A changed test file is not the only possible affected test. Full-project type checking remains available locally. Run repository-wide checks locally only on explicit request or when needed to diagnose tooling or shared-contract changes.

Run `bun install --frozen-lockfile` after changing dependency metadata before committing: the snapshot uses the installed dependencies. `bun run check` retains the full formatting, lint, typecheck, build, Vitest, and Playwright gate for CI and explicit troubleshooting. GitHub Actions runs it and hook verification on pushes and pull requests. Require the `quality` job in the hosting repository's branch protection/ruleset before relying on CI to block merges; the workflow alone does not enforce this setting.

## Hook troubleshooting

Run `bun run hooks:install` after a fresh clone if hooks are missing, and inspect `./node_modules/.bin/vp hooks status`. Vite+ stores generated dispatcher files under `.vite-hooks/_` and sets the repository's `core.hooksPath`. Existing project-owned hooks must be integrated before replacing a custom hooks path.

An explicit local `vp hooks disable` preference survives reinstall; re-enable it with `./node_modules/.bin/vp hooks enable`. `VP_GIT_HOOKS=0` and `HUSKY=0` disable hooks; remove them when checks are expected to run. Git GUI clients need the pinned Node runtime on `PATH` too. A missing runtime or dependency is an error, not a skipped check.

On check failure, use `bun run format` for formatting fixes or run the reported quality command, then stage the intended corrections and retry. `bun run hooks:check` creates only temporary test commits and verifies formatting, lint, type, and affected unit-test failures, confirms that builds and integration/E2E are deferred to CI, and checks preservation of staged and unstaged content. It never commits to the current branch.

## License

[MIT](LICENSE). Copyright (c) 2026 vova-white.
