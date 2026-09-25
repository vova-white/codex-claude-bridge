---
name: claude-delegation
description: Delegate read-only research and review assignments to Claude Code through the claude_bridge MCP tools, check readiness, and retrieve results. Use when a focused investigation or review could run in parallel with your own work, or when the user asks whether the Codex-Claude bridge is set up.
---

# Claude delegation

The `claude_bridge` MCP server connects Codex (the parent agent) to Claude Code (the child agent) through a local background service. The service runs Claude Code with the user's own Claude Code login and subscription and keeps its state under `$CODEX_CLAUDE_BRIDGE_HOME` (default `~/.local/state/codex-claude-bridge`).

## Supported scope

This release supports readiness checks and **read-only** delegated tasks: Claude inspects the project's shared checkout and reports back. You can wait for a task with a timeout, read its progress, send follow-ups to Claude's session, and cancel work. Claude cannot edit files, publish changes, receive answers to questions mid-task, or use nested agents yet. For those, do the work yourself. The `operations` field of the readiness report lists exactly what the running service supports; trust it over this document if they differ.

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
4. When you need the result, call `wait_task` with a bounded `timeoutSeconds` (up to 300). It returns as soon as the execution finishes or becomes blocked; on `timedOut: true` the task keeps running, so do other work and wait again later rather than polling in a tight loop. `wait_task` pins the execution it waits for and names it in the response. `list_tasks` finds tasks started before a reconnect.
5. When `status` is `completed`, read `task_result`. It is durable: read it again whenever needed. It returns at most `maxChars` characters (default 12,000); if `truncated` is present, call `task_result` again with `part` and `offset` from `truncated.next` to read the rest, repeating until no `truncated` remains. Read further only if you need the omitted detail.

## Follow-ups and cancellation

Use `send_followup` to continue the same Claude session: ask a clarifying question about the result, or request an adjustment. Each follow-up is a new execution with its own `executionId` and result; the original result never changes (`task_result` without `executionId` still returns it). Choose a new `requestKey` for each follow-up and reuse it only to retry the same message.

If an execution of the task is still active, the follow-up is queued behind it (`delivery: queued`, `queuedBehind`) and starts when that execution ends. Follow-ups never interrupt or steer a running turn. Wait for the follow-up's own `executionId`.

If the follow-up fails with `reason: session_unavailable`, Claude Code can no longer resume the session (or the task never reached Claude). The message was not sent to any other conversation. Start a new task whose brief includes what the follow-up needs.

`cancel_task` stops obsolete work: queued follow-ups are cancelled at once, and the running execution is stopped by ending Claude Code. `cancellation: confirmed` means Claude Code has exited; `requested` means termination is not confirmed yet, so check again with `task_status`. An execution that finished before the cancellation took effect keeps its result. Repeating the call is harmless. Cancellation stops Claude; it does not undo changes Claude already made. You can send a new follow-up to the session after cancelling.

## Reading progress

Read progress only when it helps you decide something, such as whether a long task is on track. `read_output` returns the execution's events after a cursor: status changes, Claude's messages, the tools it called with their inputs, and the final summary. Keep reads small: start with the default `limit` and `maxChars`, pass the returned `nextCursor` as `after` to continue (cursors stay valid after reconnecting), and stop when `hasMore` is false. An event cut to fit `maxChars` is marked `truncated`; read just that event in full with `after` set to its `seq` minus 1, `limit: 1`, and a larger `maxChars`. `lastEventSeq` from `wait_task` tells you whether anything new arrived. Only the newest events of long executions are kept (`retention` says how many were dropped); results are never affected.

Claude runs with the edit tools disabled and without nested agents, but shell commands remain available for inspection. This is a tool policy, not a sandbox: the bridge compares the checkout (HEAD, staged, and working files) before and after the task and lists any change in `result.workspace.modifiedFiles` and `result.failures`, or, when the execution failed and `result` is `null`, in `error.modifiedFiles`.

## Reading status and results

- `queued`, `running`: in progress. `reason: waiting_for_capacity` means Claude Code is waiting for subscription capacity (`detail.resetsAt` is a Unix time when known); the task continues on its own.
- `completed`: `task_result` has `summary`, `evidence`, `failures`, `remainingWork`, and `workspace`.
- `failed`: `reason` is `authentication` (not a verified subscription login, detected before the brief is sent, or an authentication error from Claude Code), `subscription_limit`, `invalid_request` (for example an unavailable model), `session_unavailable` (a follow-up whose session cannot be resumed), or `provider_error`. `error.message` names the reason and a category the bridge determines itself (the error code or result subtype Claude Code reported, the exit code or signal of its process, a timeout) and, when known, when subscription capacity resets; it never contains Claude Code's own output. Relay `error.message` and `error.action`: the action tells the user how to see the full output, usually by running `claude` in the project and `/resume` with the task's `sessionId`. Do not resubmit in a loop.
- `cancelled`: stopped by `cancel_task`; `detail.processExited` confirms Claude Code exited.
- `interrupted`: the bridge service stopped while the task ran. The result may be incomplete; decide whether to start a new task with a new request key.

Review the result in proportion to its risk: check the evidence behind claims you will act on, rather than repeating the whole investigation.

## Checking readiness

Call `readiness` with `project` set to the absolute path of the Git checkout the work concerns. The check starts Claude Code briefly without sending a prompt, so it costs no model usage.

Read the report:

- `ready`: `true` only when no blocking problem exists.
- `problems`: each has a `code`, a `message`, and an `action` the user can take. `blocking: false` problems, such as an unavailable optional MCP integration, do not prevent delegation.
- `credentials`: `source` must be `subscription` with `verified: true`. An API key, a third-party provider (Bedrock, Vertex, and similar), or a missing login is never treated as the subscription. Relay the `action`; do not suggest API-key billing as a workaround.
- `claude`: the Claude Code executable, its version, and whether it is compatible with the bridge's Claude Agent SDK.
- `models`: model identifiers Claude Code offers, with their effort levels. Choose among these values; do not invent model names.
- `git`: Git availability and, for `project`, the repository root.
- `integrations`: MCP servers configured for Claude in the bridge's `config.json` (`configured`) and the number of servers Claude Code loads from its own settings, by status (`fromClaudeSettings`). Codex's own tools, connectors, credentials, and approvals are never inherited by Claude (`codexTools.inherited: false`); a capability Claude needs must be configured for it explicitly.

Readiness reports and the service log contain only diagnostics the bridge composes itself: problem codes, configured MCP server names and their statuses, start-up failure categories (timeout, executable not runnable, exit code or signal of the process), known account values, model identifiers, and actions. They never contain error text or stderr from Claude Code, the Agent SDK, or MCP servers. When the user needs the full error, tell them to run `claude` in a terminal and inspect `/mcp`.

When readiness fails, report the problems and their actions to the user instead of retrying in a loop. Re-run `readiness` after the user says the problem is fixed.

## Configuration

`config.json` in the state directory accepts:

- `claudeExecutable`: absolute path to Claude Code when `claude` is not on the service `PATH`.
- `claudeConfigDir`: a separate Claude Code configuration directory (sets `CLAUDE_CONFIG_DIR`).
- `mcpServers`: MCP servers Claude may use, in Claude Code's `mcpServers` format. Readiness reports each configured server by name and status only, never its configuration or its error text; the user can see a connection error by running `claude` in a terminal and inspecting `/mcp`.

The service reads the file on every check, so edits apply without a restart.
