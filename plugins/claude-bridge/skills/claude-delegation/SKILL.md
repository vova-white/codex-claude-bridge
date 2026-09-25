---
name: claude-delegation
description: Delegate research, review, and code-change assignments to Claude Code through the claude_bridge MCP tools (read-only on the shared checkout, or writing in an isolated Git worktree), check readiness, and retrieve results. Use when a focused investigation or review could run in parallel with your own work, or when the user asks whether the Codex-Claude bridge is set up.
---

# Claude delegation

The `claude_bridge` MCP server connects Codex (the parent agent) to Claude Code (the child agent) through a local background service. The service runs Claude Code with the user's own Claude Code login and subscription and keeps its state under `$CODEX_CLAUDE_BRIDGE_HOME` (default `~/.local/state/codex-claude-bridge`).

## Supported scope

This release supports readiness checks, **read-only** tasks (Claude inspects the project's shared checkout and reports back, and may engage nested read-only agents; see "Nested agents"), and **writing** tasks (Claude changes files and commits them in its own Git worktree and task branch, without nested agents). You can wait for a task with a timeout, read its progress, send follow-ups to Claude's session, and cancel work. Claude cannot push, open pull requests, or receive answers to questions mid-task yet. For those, do the work yourself. The `operations` field of the readiness report lists exactly what the running service supports; trust it over this document if they differ.

## When to delegate

Delegate a focused investigation, review, or implementation that Claude can complete from the repository alone, when you have other work to do meanwhile. Keep small, quick, or tightly coupled work yourself: preparing the brief and reviewing the result also cost time.

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

## Delegating a writing task

Pass `mode: "write"` to `start_task` for a code change. The service creates a new Git worktree on its own GitFlow task branch (`branchType`: `feature` by default, or `bugfix`, `hotfix`, `release`, `support`) before Claude starts, and Claude edits, installs dependencies, runs checks, and commits only there. Your checkout and other tasks' worktrees are not touched. A worktree isolates Git changes; it is not a sandbox.

The worktree starts from a committed revision. If your checkout has uncommitted changes, `start_task` refuses with `dirty_parent`, because Claude would not see them: commit what Claude needs first, or pass `baseline` (for example `"HEAD"`) to start deliberately from that commit without them. The result's `workspace.parentDirty` records that choice.

The result adds `checks` (each check Claude ran and whether it passed) and `workspace`: `path`, `branch`, `baseline`, `commits` since the baseline, and `changedFiles` (committed or not). The worktree and its changes stay after completion, failure, and cancellation (`detail.workspace`), so you can review them, send follow-ups (which run in the same worktree), or take the changes over. Review the changes in proportion to their risk — `git -C <path> log <baseline>..HEAD`, `git -C <path> diff <baseline>` (working files), and `git -C <path> status` (staged and untracked files) — and verify the checks that matter rather than repeating all of Claude's work. A failure with `reason: workspace_error` means the worktree could not be created and nothing ran.

## Follow-ups and cancellation

Use `send_followup` to continue the same Claude session: ask a clarifying question about the result, or request an adjustment. Each follow-up is a new execution with its own `executionId` and result; the original result never changes (`task_result` without `executionId` still returns it). Choose a new `requestKey` for each follow-up and reuse it only to retry the same message.

If an execution of the task is still active, the follow-up is queued behind it (`delivery: queued`, `queuedBehind`) and starts when that execution ends. Follow-ups never interrupt or steer a running turn. Wait for the follow-up's own `executionId`.

If the follow-up fails with `reason: session_unavailable`, Claude Code can no longer resume the session (or the task never reached Claude). The message was not sent to any other conversation. Start a new task whose brief includes what the follow-up needs.

`cancel_task` stops obsolete work: queued follow-ups are cancelled at once, and the running execution is stopped by asking Claude Code to stop its nested agents and then ending Claude Code. `cancellation: confirmed` means Claude Code has exited; `requested` means termination is not confirmed yet, so check again with `task_status`. An execution that finished before the cancellation took effect keeps its result. Repeating the call is harmless. Cancellation stops Claude; it does not undo changes Claude already made. You can send a new follow-up to the session after cancelling. Each execution lists its nested agents with a `termination`: `reported` (Claude Code reported the agent stopped), `process_exit` (it ended with Claude Code's process without being reported), or `unconfirmed` (it may still run). `controlGap` is present when Claude Code did not report stopping some of them; tell the user when it matters. The bridge never controls work nested agents started outside Claude Code, such as background commands.

## Nested agents

Claude may start nested agents with its Agent tool for independent research or review subtasks, when the gain in quality or elapsed time justifies the extra usage and coordination; its instructions keep small, sequential, or tightly coupled work local. Nested agents get the same read-only tool policy: Claude Code applies the task's disabled edit tools to them too, whatever agent type Claude picks. You do not ask for nested agents, and they are not Codex collaboration agents: you interact only with the task. To keep a task small and cheap, say so in the brief.

Claude remains accountable for nested work and incorporates it into its own result; the bridge records each nested agent separately and never merges or invents results. `task_status` lists them per execution as `nested`: `taskId`, `description`, `agentType`, `background`, `depth` and `parentToolUseId` (which nested agent's `toolUseId` started it; absent when Claude did), `status` (`running`, `completed`, `failed`, `stopped`, `unknown`), Claude Code's `summary`, and `termination`. `read_output` shows their starts, tool calls, progress, and ends as `nested` events.

When Claude finishes its turn while nested agents it started still run, the execution stays `running` with `reason: waiting_for_children` and `detail.runningNested`. It is not complete: Claude continues when they end and its later result becomes the task result. `wait_task` keeps waiting through this state. If Claude Code exits while nested agents still run, the execution fails with `provider_error` rather than reporting a completed assignment. If nested agents never end, the execution waits until you cancel it.

## Reading progress

Read progress only when it helps you decide something, such as whether a long task is on track. `read_output` returns the execution's events after a cursor: status changes, Claude's messages, the tools it called with their inputs, and the final summary. Keep reads small: start with the default `limit` and `maxChars`, pass the returned `nextCursor` as `after` to continue (cursors stay valid after reconnecting), and stop when `hasMore` is false. An event cut to fit `maxChars` is marked `truncated`; read just that event in full with `after` set to its `seq` minus 1, `limit: 1`, and a larger `maxChars`. `lastEventSeq` from `wait_task` tells you whether anything new arrived. Only the newest events of long executions are kept (`retention` says how many were dropped); results are never affected.

In read-only tasks, Claude and its nested agents run with the edit tools disabled, but shell commands remain available for inspection. This is a tool policy, not a sandbox: the bridge compares the checkout (HEAD, staged, and working files) before and after the task and lists any change in `result.workspace.modifiedFiles` and `result.failures`, or, when the execution failed or was cancelled and `result` is `null`, in `detail.modifiedFiles`. Writing tasks report their changes in `workspace.changedFiles` and `workspace.commits` instead: in `result.workspace` when completed, in `detail.workspace` when failed or cancelled.

## Reading status and results

- `queued`, `running`: in progress. `reason: waiting_for_capacity` means Claude Code is waiting for subscription capacity (`detail.resetsAt` is a Unix time when known); the task continues on its own. `reason: waiting_for_children` means Claude's turn ended while nested agents still run; the result is not ready yet.
- `completed`: `task_result` has `summary`, `evidence`, `failures`, `remainingWork`, and `workspace`.
- `failed`: `reason` is `authentication` (not a verified subscription login, detected before the brief is sent, or an authentication error from Claude Code), `subscription_limit`, `invalid_request` (for example an unavailable model), `session_unavailable` (a follow-up whose session cannot be resumed), `workspace_error` (a writing task's worktree could not be created), or `provider_error`. `error.message` reads `Execution failed with <reason>: <cause>.` The cause is composed by the bridge: a check it made before sending anything (no verified subscription login, a model Claude Code does not offer, no session to continue, Claude Code not found, a worktree that could not be created), the error code or result subtype Claude Code reported, the exit code or signal of its process, nested agents still running when Claude Code exited, or a timeout. For `subscription_limit` the message adds when capacity resets, when known; if a read-only task changed the checkout, it gives the number of files, listed in `detail.modifiedFiles`; for a writing task, it gives the number of commits and changed files in its worktree, listed in `detail.workspace`. It never contains Claude Code's own output. Relay `error.message` and `error.action`. Before Claude Code has started a session, the action says how to fix what was checked: fix the credential setup or sign in, choose a model from the readiness `models`, start a new task with the context a follow-up needs, install Claude Code, check that the repository accepts new worktrees, call `readiness`, or run `claude` in the project to check that it starts and is signed in. Once a session exists, the action always includes how to see Claude Code's full output: run `claude` in the project and `/resume` the task's `sessionId` (or pick the task's session when no `sessionId` is reported). It also says to `/login` for `authentication`, to wait for the reset and start a new task with a new request key for `subscription_limit`, and otherwise to start a new task with a new request key once the problem is fixed. Do not resubmit in a loop.
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
