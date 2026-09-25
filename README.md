# Codex to Claude bridge

Delegate work from Codex to Claude Code without leaving Codex. The bridge is a personal Codex plugin: Codex hands Claude a bounded task, Claude works on it in the background with your existing Claude Code login, and Codex reads the result, answers Claude's questions, and reviews what it did.

What it can do:

- **Read-only tasks.** Reviews, investigations, and research on your current checkout, optionally with nested Claude agents.
- **Writing tasks.** Changes in an isolated Git worktree on a separate branch, so your checkout stays untouched. Claude can split the work among parallel nested writers and, if you allow it, push the branch and open a pull request.
- **Long-running work.** Tasks run in a background service and survive Codex restarts. Codex can wait for a task, read its progress, send follow-ups to the same Claude session, and cancel it.
- **Questions and approvals.** When Claude asks a question or needs approval to use a tool, Codex answers.
- **Cleanup.** Remove a task's worktrees and branches when you are done, with safeguards against losing unmerged commits.

> **Platform support.** The bridge is developed and tested on Ubuntu under WSL 2. macOS and native Windows are not tested and may not work.

## Requirements

- [Codex CLI](https://github.com/openai/codex)
- [Claude Code](https://docs.claude.com/en/docs/claude-code), signed in with a Claude subscription. API keys and third-party providers are not supported.
- Node.js **24.21.0**, on the `PATH` that Codex uses
- Bun **1.4.2**, only to install dependencies and build
- Git **2.32** or newer
- Optional: the GitHub CLI (`gh`), signed in, if you want Claude to open pull requests

## Installation

1. Install Node.js and Bun with your version manager (the repository pins them in `.node-version` and `package.json`) or with the official [Node.js 24.21.0](https://nodejs.org/dist/v24.21.0/) and [Bun](https://bun.sh/docs/installation) installers.

2. Sign in to Claude Code: run `claude`, then `/login`.

3. Clone the repository and build the plugin:

   ```sh
   git clone https://github.com/vova-white/codex-claude-bridge.git
   cd codex-claude-bridge
   bun install --frozen-lockfile
   bun run build:plugin
   ```

4. Register the checkout as a local plugin marketplace and install the plugin:

   ```sh
   codex plugin marketplace add "$PWD"
   codex plugin add claude-bridge@codex-claude-bridge
   ```

5. Start Codex and ask it to check Claude readiness. It reports whether Claude Code is found and signed in and which models it offers.

### Updating

Codex runs its own cached copy of the plugin, so rebuilding the checkout alone changes nothing. Rebuild and reinstall:

```sh
git pull
bun install --frozen-lockfile
bun run build:plugin
codex plugin remove claude-bridge@codex-claude-bridge
codex plugin add claude-bridge@codex-claude-bridge
```

Then [stop the service](#stopping-the-service) if it is running, so the next request starts the new version.

### Versions

The bridge follows [Semantic Versioning](https://semver.org), and [`CHANGELOG.md`](CHANGELOG.md) lists what changed in each version. Before 1.0, a breaking change raises the minor version (0.1 → 0.2) and everything else raises the patch version. A change is breaking when something that worked stops working after an update: the MCP tools' inputs, outputs, and errors that the delegation skill relies on, the CLI commands, `config.json`, or a state directory left by an earlier version.

Every release is a Git tag `vX.Y.Z` with a GitHub release. To install a specific version, check out its tag before building, for example `git checkout v0.1.0`.

## Usage

Ask Codex in plain words, for example:

- "Ask Claude to review the error handling in `src/service`."
- "Have Claude rewrite the README as a writing task and open a pull request."

The plugin's `claude-delegation` skill teaches Codex how to brief Claude, wait for the result, and review it. When you have merged a writing task's branch or no longer need it, ask Codex to clean up the task.

## Configuration

The bridge keeps its state in `$CODEX_CLAUDE_BRIDGE_HOME`, or `$XDG_STATE_HOME/codex-claude-bridge` (by default `~/.local/state/codex-claude-bridge`). Task worktrees live under `worktrees/`, and the service writes its diagnostics to `service.log`.

To change the defaults, create `config.json` there. The service reads it whenever it needs it, so there is no need to restart.

| Key                       | Meaning                                                                                                                                                              |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claudeExecutable`        | Absolute path to Claude Code when `claude` is not on the service `PATH`                                                                                              |
| `claudeConfigDir`         | Separate Claude Code configuration directory, passed as `CLAUDE_CONFIG_DIR`                                                                                          |
| `mcpServers`              | MCP servers Claude may use, in Claude Code's format. `"autoApprove": true` lets Claude call a server's tools without asking Codex. `codex_claude_bridge` is reserved |
| `maxConcurrentExecutions` | How many Claude runs may work at once across all tasks (default 2); the rest wait in line                                                                            |

```json
{
  "maxConcurrentExecutions": 3,
  "mcpServers": {
    "context7": { "command": "npx", "args": ["-y", "@upstash/context7-mcp"], "autoApprove": true }
  }
}
```

Codex's own tools and connectors are not available to Claude; it gets only its task's tools and the MCP servers you configure here.

## How it works

Codex launches the plugin's MCP server, a thin process without state. On first use it starts a background bridge service, which owns all tasks, stores them in SQLite in the state directory, and runs Claude Code through the Claude Agent SDK. One service serves every Codex session and keeps running after Codex exits, so tasks continue in the background. If the service stops, the next one marks unfinished runs as interrupted; nothing reruns on its own, but a follow-up resumes the Claude session.

### Stopping the service

Send `SIGTERM` to the PID recorded in `service.json` in the state directory:

```sh
kill "$(node -p 'require(process.argv[1]).pid' ~/.local/state/codex-claude-bridge/service.json)"
```

The next request to the bridge starts a new service.

### Troubleshooting

Bridge diagnostics (readiness problems, task errors, and `service.log`) never copy error text from Claude Code, MCP servers, `git`, or `gh`, so that credentials cannot leak through them. To see the full error, run `claude` in the project: `/mcp` shows MCP server problems, and `/resume` opens the session a failed task reports.

## Development

```sh
bun install --frozen-lockfile
bun run dev
```

Node runs the application, scripts, and tests; Bun only manages dependencies, so `bun test` is not used. Installing dependencies also installs the Git pre-commit hook; if you installed with `--ignore-scripts`, run `bun run hooks:install`. Tooling comes from Vite+ (Vitest, Oxlint, Oxfmt, tsdown); types are checked by the native TypeScript 7 `tsc`.

Dependency versions are exact: commit `package.json` and `bun.lock` together. `trustedDependencies` is empty on purpose, so review any dependency that needs an installation script before adding it there.

Terminology is in [`CONTEXT.md`](CONTEXT.md), and design decisions are in [`docs/adr/`](docs/adr/).

### Commands

Run them with `bun run <name>`.

| Script                           | Purpose                                                       |
| -------------------------------- | ------------------------------------------------------------- |
| `dev`                            | Run the CLI from source in watch mode                         |
| `build` / `start`                | Bundle the CLI into `dist/cli.mjs` / run the bundle           |
| `build:plugin`                   | Bundle the CLI into the plugin directory for Codex            |
| `typecheck`                      | Strict type checking of the whole project                     |
| `lint`                           | Oxlint; warnings fail                                         |
| `format` / `format:check`        | Apply or verify formatting, including Markdown                |
| `test`                           | All unit and integration tests                                |
| `test:unit` / `test:integration` | One test category                                             |
| `test:e2e`                       | Build a temporary bundle and run the Playwright process tests |
| `smoke`                          | Opt-in check against the installed Claude Code                |
| `check`                          | The full CI gate: formatting, lint, types, build, all tests   |
| `hooks:install` / `hooks:check`  | Install the Git hook / verify it in a disposable repository   |

### Tests

- `tests/unit/`: argument parsing, Claude Code version compatibility, and diagnostic redaction.
- `tests/integration/`: the public MCP boundary. Each test runs the real MCP server and service in its own temporary state directory, with `tests/fixtures/fake-claude.ts` in place of Claude Code and `tests/fixtures/fake-gh.ts` in place of `gh`.
- `tests/e2e/`: Playwright runs the built plugin outside the checkout, the way Codex installs it. No browsers are needed.

Automated tests need no Claude credentials, model calls, or GitHub access. `bun run smoke` is the exception and never runs in CI: it drives the bridge against your installed Claude Code and login in a temporary directory and spends a little subscription usage. `--readiness-only` stops before sending a prompt, `--bundle` uses `dist/cli.mjs`, and `--claude <path>` names the Claude Code executable.

### Commit hook

The pre-commit hook checks the staged snapshot and never modifies your files:

1. Formatting and lint of staged files.
2. The full type check, unless only Markdown changed.
3. Unit tests related to the changed files.

Builds, integration, and E2E tests run in CI (`bun run check`). If a check fails, fix it (`bun run format` handles formatting), stage the fix, and commit again. If hooks do not run, check `./node_modules/.bin/vp hooks status` and make sure `VP_GIT_HOOKS=0` or `HUSKY=0` is not set.

## License

[MIT](LICENSE). Copyright (c) 2026 vova-white.
