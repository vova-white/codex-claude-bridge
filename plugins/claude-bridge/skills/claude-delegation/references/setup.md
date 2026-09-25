# Readiness and configuration

The service runs Claude Code with the user's own login and subscription. Its state lives under `$CODEX_CLAUDE_BRIDGE_HOME`, or `$XDG_STATE_HOME/codex-claude-bridge` (default `~/.local/state/codex-claude-bridge`).

Contents: [Checking readiness](#checking-readiness) · [Configuration](#configuration).

## Checking readiness

Call `readiness` with `project` set to the absolute path of the Git checkout the work concerns. The check starts Claude Code briefly without sending a prompt, so it costs no model usage.

Read the report:

- `ready`: `true` only when no blocking problem exists.
- `problems`: each has a `code`, a `message`, and an `action` the user can take. `blocking: false` problems, such as an unavailable optional MCP integration, do not prevent delegation.
- `credentials`: `source` must be `subscription` with `verified: true`. An API key, a third-party provider (Bedrock, Vertex, and similar), or a missing login is never treated as the subscription. Relay the `action`; do not suggest API-key billing as a workaround.
- `claude`: the Claude Code executable, its version, and whether it is compatible with the bridge's Claude Agent SDK.
- `models`: model identifiers Claude Code offers, with their effort levels. Choose among these values. When the user requests a version but readiness lists an alias, verify its mapping for the installed Claude Code version and provider using the [Claude Code model configuration docs](https://code.claude.com/docs/en/model-config) and any applicable local model overrides before using it, then check execution `usage.models`. If the requested model is unavailable or the mapping is uncertain, explain that and ask about an alternative rather than silently substituting one.
- `git`: Git availability and, for `project`, the repository root.
- `integrations`: MCP servers configured for Claude in the bridge's `config.json` (`configured`) and the number of servers Claude Code loads from its own settings, by status (`fromClaudeSettings`). Codex's own tools, connectors, credentials, and approvals are never inherited by Claude (`codexTools.inherited: false`); a capability Claude needs must be configured for it explicitly.

Readiness reports and the service log contain only diagnostics the bridge composes itself: problem codes, configured MCP server names and their statuses, start-up failure categories (timeout, executable not runnable, exit code or signal of the process), known account values, model identifiers, and actions. They never contain error text or stderr from Claude Code, the Agent SDK, or MCP servers. When the user needs the full error, tell them to run `claude` in a terminal and inspect `/mcp`.

When readiness fails, report the problems and their actions to the user instead of retrying in a loop. Re-run `readiness` once the reported cause has been addressed.

## Configuration

`config.json` in the state directory accepts:

- `claudeExecutable`: absolute path to Claude Code when `claude` is not on the service `PATH`.
- `claudeConfigDir`: a separate Claude Code configuration directory (sets `CLAUDE_CONFIG_DIR`).
- `maxConcurrentExecutions`: how many executions run at once, a positive integer (default 2). An edit applies the next time work is queued or ends, or `list_tasks`, `task_status`, or `wait_task` is called; running executions are never stopped for it.
- `mcpServers`: MCP servers Claude may use, in Claude Code's `mcpServers` format. Readiness reports each configured server by name and status only, never its configuration or its error text; the user can see a connection error by running `claude` in a terminal and inspecting `/mcp`. Each call to their tools waits for your approval unless the server entry sets `"autoApprove": true`. The name `codex_claude_bridge` is reserved for the bridge's own tools.

The service reads the file on every check, so edits apply without a restart.
