---
name: claude-delegation
description: Delegate read-only research and review assignments to Claude Code through the claude_bridge MCP tools, check readiness, and retrieve results. Use when a focused investigation or review could run in parallel with your own work, or when the user asks whether the Codex-Claude bridge is set up.
---

# Claude delegation

The `claude_bridge` MCP server connects Codex (the parent agent) to Claude Code (the child agent) through a local background service. The service runs Claude Code with the user's own Claude Code login and subscription and keeps its state under `$CODEX_CLAUDE_BRIDGE_HOME` (default `~/.local/state/codex-claude-bridge`).

## Supported scope

This release supports readiness checks and **read-only** delegated tasks: Claude inspects the project's shared checkout and reports back. It cannot edit files, publish changes, wait with a timeout, take follow-ups, answer questions mid-task, be cancelled, or use nested agents yet. For those, do the work yourself. The `operations` field of the readiness report lists exactly what the running service supports; trust it over this document if they differ.

## When to delegate

Delegate a focused investigation or review that Claude can complete from the repository alone, when you have other work to do meanwhile. Keep small, quick, or tightly coupled work yourself: preparing the brief and reviewing the result also cost time.

## Delegating a read-only task

1. Check `readiness` once per session for the project. Do not delegate unless `ready` is true.
2. Call `start_task` with:
   - `project`: absolute path of the Git checkout.
   - `requestKey`: a key you choose for this request, such as `review-auth-2`. If the call fails or its response is lost, call `start_task` again with the same key and arguments: you get the same task back, never a second one. Use a new key for different work; reusing a key with different arguments fails.
   - `assignment`: a self-contained brief. Claude sees nothing of this conversation except `assignment`, `context`, and `expectedResult`.
   - `context`: file paths, findings, constraints, and decisions Claude needs.
   - `expectedResult`: what a complete answer contains.
   - Optionally `model` and `effort`, chosen from the readiness `models`.
3. The call returns `taskId` and `executionId` at once. Continue your own work; the task runs in the background service and keeps running if Codex disconnects or closes.
4. Check progress with `task_status` or `list_tasks` when you need the result, not in a tight loop. `list_tasks` also finds tasks started before a reconnect.
5. When `status` is `completed`, read `task_result`. It is durable: read it again whenever needed.

Claude runs with the edit tools disabled and without nested agents, but shell commands remain available for inspection. This is a tool policy, not a sandbox: the bridge compares the checkout (HEAD, staged, and working files) before and after the task and lists any change in `result.workspace.modifiedFiles` and `result.failures`, or, when the execution failed and `result` is `null`, in `error.modifiedFiles`.

## Reading status and results

- `queued`, `running`: in progress. `reason: waiting_for_capacity` means Claude Code is waiting for subscription capacity (`detail.resetsAt` is a Unix time when known); the task continues on its own.
- `completed`: `task_result` has `summary`, `evidence`, `failures`, `remainingWork`, and `workspace`.
- `failed`: `reason` is `authentication` (not a verified subscription login; the brief was not sent), `subscription_limit`, `invalid_request` (for example an unavailable model), or `provider_error`. Relay `error.message` and `error.action`. Do not resubmit in a loop.
- `interrupted`: the bridge service stopped while the task ran. The result may be incomplete; decide whether to start a new task with a new request key.

Review the result in proportion to its risk: check the evidence behind claims you will act on, rather than repeating the whole investigation.

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
- `mcpServers`: MCP servers Claude may use, in Claude Code's `mcpServers` format. The bridge never echoes their `env`, `headers`, or `args` values or the credentials and query strings of their URLs.

The service reads the file on every check, so edits apply without a restart.
