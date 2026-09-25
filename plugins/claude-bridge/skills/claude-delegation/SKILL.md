---
name: claude-delegation
description: Check whether Claude Code is ready to take delegated work through the claude_bridge MCP tools, and interpret the readiness report. Use before planning to hand work to Claude, or when the user asks whether the Codex-Claude bridge is set up.
---

# Claude delegation

The `claude_bridge` MCP server connects Codex (the parent agent) to Claude Code (the child agent) through a local background service. The service runs Claude Code with the user's own Claude Code login and subscription and keeps its state under `$CODEX_CLAUDE_BRIDGE_HOME` (default `~/.local/state/codex-claude-bridge`).

## Supported scope

This release supports one operation: `readiness`. It does not start, wait for, continue, or cancel delegated tasks yet. Do not claim that work was delegated to Claude; do the work yourself or tell the user that delegation is not available in this release. The `operations` field of the readiness report lists exactly what the running service supports; trust it over this document if they differ.

## Checking readiness

Call `readiness` with `project` set to the absolute path of the Git checkout the work concerns. The check starts Claude Code briefly without sending a prompt, so it costs no model usage.

Read the report:

- `ready`: `true` only when no blocking problem exists.
- `problems`: each has a `code`, a `message`, and an `action` the user can take. `blocking: false` problems, such as an unavailable optional MCP integration, do not prevent delegation.
- `credentials`: `source` must be `subscription` with `verified: true`. An API key, a third-party provider (Bedrock, Vertex, and similar), or a missing login is never treated as the subscription. Relay the `action`; do not suggest API-key billing as a workaround.
- `claude`: the Claude Code executable, its version, and whether it is compatible with the bridge's Claude Agent SDK.
- `models`: the models and effort levels Claude Code reports. Choose among these values; do not invent model names.
- `git`: Git availability and, for `project`, the repository root.
- `integrations`: MCP servers configured for Claude in the bridge's `config.json` (`configured`) and those Claude Code loads from its own settings (`fromClaudeSettings`). Codex's own tools, connectors, credentials, and approvals are never inherited by Claude (`codexTools.inherited: false`); a capability Claude needs must be configured for it explicitly.

When readiness fails, report the problems and their actions to the user instead of retrying in a loop. Re-run `readiness` after the user says the problem is fixed.

## Configuration

`config.json` in the state directory accepts:

- `claudeExecutable`: absolute path to Claude Code when `claude` is not on the service `PATH`.
- `claudeConfigDir`: a separate Claude Code configuration directory (sets `CLAUDE_CONFIG_DIR`).
- `mcpServers`: MCP servers Claude may use, in Claude Code's `mcpServers` format. The bridge never echoes their `env` or `headers` values.

The service reads the file on every check, so edits apply without a restart.
