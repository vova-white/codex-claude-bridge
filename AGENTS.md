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

Track process IDs at spawn and stop only processes owned by the current task. Keep development and test databases and workspaces isolated from the installed bridge's live state. Use synthetic fixtures and a deterministic provider substitute, without real credentials or model calls. Wait for observable events or operation completion; use timeouts as failure bounds rather than fixed delays.

For lifecycle changes, identify which of start, repeated requests, cancellation, disconnect/reconnect, and recovery are affected, and test those scenarios through the public boundary.

### Documentation

Record durable decisions, cross-component constraints, and reasons that are hard to recover from code. Keep local implementation explanations beside the code and shared vocabulary in `CONTEXT.md`. Rewrite or remove obsolete guidance when behavior changes instead of appending another account. Keep temporary plans and scratch files outside the worktree; track active work in its GitHub issue.
