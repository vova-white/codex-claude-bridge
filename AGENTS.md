# Codex to Claude bridge

A personal Codex plugin that delegates bounded tasks to Claude Code through a local background service, using the user's existing Claude Code login. `CONTEXT.md` defines the vocabulary; use it in code, issues, and tests. In this file, **you** are the agent changing the bridge, **we** are its maintainers, and **user** is the person running Codex with the plugin installed.

## Good defaults

Prefer simple systems and software that feels obvious. Understand the real constraint, then fight for the smallest model that makes the correct behavior unsurprising. Complexity earns its place through a constraint you can name; do not keep it because it already exists, and do not add it because it looks architecturally impressive.

Channel both "measure twice, cut once" and "yagni". Fight scope creep and honor the developer's intent in a minimal, realistic form.

Treat the rest of this document as good defaults rather than hard rules; the developer's stated preferences override it. If a rule here fights the task in front of you, say so loudly and get a sign-off before breaking it.

## Ways to hurt yourself

1. **Killing by pattern.** The installed bridge service is `node dist/cli.mjs service`, it may be the process running you, and its Claude Code children work inside checkouts like this one. Stop only a PID you captured at spawn. `pkill -f`, `pgrep | kill`, or a PID found by matching a name or path can end the live bridge together with your own session.
2. **Touching the live state directory.** `~/.local/state/codex-claude-bridge` (or `$CODEX_CLAUDE_BRIDGE_HOME`) belongs to the installed bridge in use while you work. Point every development run and test at a temporary directory through `CODEX_CLAUDE_BRIDGE_HOME`; `tests/support/bridge.ts` already does this.
3. **Rebuilding into a cached plugin.** Codex runs its own copy of the plugin, not `plugins/claude-bridge/`. After `bun run build:plugin`, a change reaches Codex only after `codex plugin remove` and `codex plugin add` (see README).

## Every surface

The most common defect is a change that works on the path you tested and is missing everywhere else. Before calling work done, walk this list and say which entries applied:

- **Lifecycle.** Start, repeated requests, cancellation, disconnect/reconnect, and recovery. Identify which are affected and test those scenarios through the public MCP boundary.
- **Contract and skill.** An MCP tool's input, output, and errors are also described in `plugins/claude-bridge/skills/claude-delegation/SKILL.md`, which is how the parent agent learns to use them. Change them together.
- **Reverse states.** If you add a way in, add the way out and the way to see it. A start needs a cancel, a running task needs a status, a persisted execution needs a recovery path.
- **Docs.** README, `CONTEXT.md`, and ADRs. Apply the documentation rules below before adding anything.

## Where code lives

- `src/cli.ts` and `src/arguments.ts`: the CLI entry point with its `mcp` and `service` commands.
- `src/mcp/`: the stateless stdio MCP entry point that Codex launches.
- `src/service/`: the background service, its launcher, task lifecycle, and SQLite store.
- `src/claude/`: readiness checks, version compatibility, and the Agent SDK execution adapter.
- `src/ipc.ts`, `src/state.ts`, `src/config.ts`, `src/redact.ts`, `src/workspace.ts`: the socket protocol, state directory, `config.json`, credential redaction, and Git workspace shared by both sides.
- `plugins/claude-bridge/`: the Codex plugin manifest, `.mcp.json`, and the delegation skill. Its `dist/` is a build output.
- `tests/`: unit, integration (real MCP entry point and service with `fixtures/fake-claude.ts`), and Playwright E2E. README describes the boundaries.

## Taste

- Complexity belongs at the Claude Code adapter boundary. The task lifecycle in the service and the MCP layer stay plain.
- Inferred types over annotations. `any` is the enemy.
- Comments describe how a thing is used and move with the code. They describe functions rather than annotate lines.
- Secrets stay out of logs, results, and command lines. Redaction is a contract, not a nicety.

## Pull requests

- Make a PR only when the developer asks for one.
- Conventional Commits titles in plain language: `fix(service): report interrupted executions after restart`.
- Body: the problem in a sentence or two, then how you fixed it.
- One concern per PR. If the description says "also", split it.
- When babysitting a PR: read checks and comments newer than the last push, verify each bot finding against the source, fix real ones, and dismiss false positives with a written reason. Stop when checks are green on the latest commit.

## Agent skills

### Issue tracker

Issues and specs use GitHub Issues. Before working with tickets, read `docs/agents/issue-tracker.md`.

### Triage labels

Use the five default triage labels. Before triaging issues, read `docs/agents/triage-labels.md`.

### Domain docs

Use a single-context layout: root `CONTEXT.md` and `docs/adr/`. Before exploring the codebase, read `docs/agents/domain.md`.

### Development

Before changing code or tooling, read `README.md` for runtime requirements, test boundaries, and the commit-check policy. The accepted runtime change is recorded in `docs/adr/0003-node-runtime-and-bun-package-management.md`.

### Verifying

- Choose the smallest check that demonstrates the change works: selected test files and lint for the affected code.
- Test observable behavior and meaningful logic. Avoid tests that merely repeat the implementation.
- Leave repository-wide formatting, lint, builds, and test suites to CI unless the user asks for them.
- The commit hook handles full-project type checking. An extra manual run is only needed to investigate a type issue.
- Use successful results already obtained for the current changes; do not rerun checks just to finish the task.

### Processes and test state

Use synthetic fixtures and a deterministic provider substitute, without real credentials or model calls. Wait for observable events or operation completion; use timeouts as failure bounds rather than fixed delays.

### Documentation

Record durable decisions, cross-component constraints, and reasons that are hard to recover from code. Keep local implementation explanations beside the code and shared vocabulary in `CONTEXT.md`. Rewrite or remove obsolete guidance when behavior changes instead of appending another account. Keep temporary plans and scratch files outside the worktree; track active work in its GitHub issue.
