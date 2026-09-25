# Changelog

Notable changes for users of the plugin. The project follows [Semantic Versioning](https://semver.org); see [Versions](README.md#versions) for what counts as a breaking change. release-please writes new entries from Conventional Commits.

## 0.1.0 (2026-09-25)

The first version of the bridge.

### Added

- Read-only Claude tasks on the current checkout: reviews, investigations, and research, optionally with nested read-only agents.
- Writing tasks in an isolated Git worktree on their own branch, with parallel nested writers and optional push and pull request publication.
- A background service that owns tasks in SQLite, runs executions within a configured number of slots, and reconciles unfinished work after a restart.
- Waiting for results, bounded progress and result paging, follow-ups in the same Claude session, and cancellation.
- Answers to Claude's questions and tool approval requests from Codex.
- Cleanup of a task's worktrees and branches that keeps unmerged commits.
- Readiness checks for Claude Code, its login, and its models.
- `config.json` for the Claude Code executable and configuration directory, MCP servers, and concurrency.
