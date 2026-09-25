---
name: claude-delegation
description: Delegate research, review, and code-change assignments to Claude Code through the claude_bridge MCP tools (read-only on the shared checkout, or writing in an isolated Git worktree, optionally delivered as a pull request), check readiness, and retrieve results. Use when a focused investigation or review could run in parallel with your own work, or when the user asks whether the Codex-Claude bridge is set up.
---

# Claude delegation

The `claude_bridge` MCP server connects Codex (the parent agent) to Claude Code (the child agent) through a local background service. The service runs Claude Code with the user's own Claude Code login and subscription and keeps its state under `$CODEX_CLAUDE_BRIDGE_HOME` (default `~/.local/state/codex-claude-bridge`).

## Supported scope

This release supports readiness checks, **read-only** tasks (Claude inspects the project's shared checkout and reports back, and may engage nested read-only agents; see "Nested agents"), and **writing** tasks (Claude changes files and commits them in its own Git worktree and task branch, may split independent changes among nested writers in worktrees of their own, and may publish the task branch as a pull request; see "Nested writers"). Several tasks can run in parallel within the service's configured limit (see "Parallel tasks and execution slots"). You can wait for a task with a timeout, read its progress, answer Claude's questions and permission requests while it waits, send follow-ups to Claude's session, cancel work, and clean up a writing task's worktree and branch. The `operations` field of the readiness report lists exactly what the running service supports; trust it over this document if they differ.

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

The result adds `checks` (each check Claude ran and whether it passed) and `workspace`: `path`, `branch`, `baseline`, `commits` since the baseline, and `changedFiles` (committed or not). The worktree and its changes stay after completion, failure, and cancellation (`detail.workspace`, with `commitCount` and `changedFileCount`), so you can review them, send follow-ups (which run in the same worktree), or take the changes over. Review the changes in proportion to their risk — `git -C <path> log <baseline>..HEAD`, `git -C <path> diff <baseline>` (working files), and `git -C <path> status` (staged and untracked files) — and verify the checks that matter rather than repeating all of Claude's work. A failure with `reason: workspace_error` means the worktree could not be created and nothing ran.

## Publishing a pull request

Add `publish: "pull_request"` to a writing task when the user wants the change delivered as a pull request. This authorizes Claude to push the task branch and create or update its pull request with `gh`, following the repository's own contribution guidance, without asking you first. Claude never merges or closes it; integration stays with you and the user. Only the task branch is published: nested writers' branches stay local, and their work reaches the pull request once Claude has assembled it into the task branch. Omit `publish` (or pass `"none"`) to keep the commits in the worktree. Claude uses the Git and GitHub credentials of the machine the bridge runs on; readiness does not check them.

After each execution that is not cancelled, the bridge reads the branch and its pull request from the remote itself and adds `publication` to the result (`detail.publication` when the execution failed; `task_status` shows the latest check): `repository`, `remote`, `branch`, `revision` (the worktree's branch tip), `pushedRevision`, `pushed` (the remote has that tip), `pullRequest` (`url`, `number`, `state`, `headRevision`, or `null`), `checkedAt`, and `concerns`. Each concern has a `code`, a `message`, and usually an `action`: `not_pushed` and `unpushed_commits` (commits exist only in the worktree), `branch_not_on_remote` (the branch is gone from the remote, as after a merge; `pullRequest.state` says what happened to it), `uncommitted_changes`, `no_pull_request`, `pull_request_closed`, and `no_remote`, `remote_unavailable`, or `github_unavailable` when the bridge could not complete its check (the values shown are then the last known ones). Publication problems never discard the worktree or its commits; relay the action or send a follow-up.

Trust `publication` over Claude's summary for what reached the remote. An execution that failed or was interrupted may still have pushed or opened a pull request: check `publication` before asking for publication again. A follow-up re-checks the remote before it starts and tells Claude about the existing pull request, so Claude updates it rather than opening another.

Review the pull request in proportion to its risk: read its diff (`gh pr diff <url>`, or the worktree against `workspace.baseline`), look at its checks (`gh pr checks <url>`) and Claude's `checks`, and verify what matters rather than repeating Claude's work. Then coordinate integration: request changes through a follow-up, or tell the user the pull request is ready to merge. Merge only when the user asks.

## Cleaning up a writing task

Worktrees and task branches stay until you call `cleanup_task`; finishing, failing, or cancelling a task never removes them. Clean up once you have integrated or abandoned the changes and need no more follow-ups: a follow-up to a cleaned-up task fails with `workspace_removed`, and one sent while `cleanup_task` runs waits for it to finish.

Call `cleanup_task` with `project`, `taskId`, and `scope`: `all` (default) removes the worktree and deletes the task branch; `worktree` removes only the worktree and keeps the branch, for example while its pull request or merge is pending. The task's nested writers (see "Nested writers") follow the same scope: their worktrees are removed, and with `all` their branches are deleted. Pass `dryRun: true` first when unsure: it reports the plan without acting. The response lists `worktree` (`path`, `uncommittedChanges`) and `branch` (`name`, `unintegratedCommits`: commits no other branch, tag, remote-tracking ref, or your checkout's HEAD contains, not counting branches the same cleanup deletes), each with an `action`: `remove` (planned), `removed`, `keep`, `already_removed`, or `failed`. `nestedWriters` lists each nested writer's `writerId` with its own `worktree` and `branch` in the same form.

`outcome` is one of:

- `refused`: nothing was removed. `refusals` gives each reason: `active_execution` (wait for or cancel the task first; nested writers run only while their execution does), `uncommitted_changes` in a worktree, or `unintegrated_commits`: commits no branch, tag, remote-tracking ref, or your checkout's HEAD that cleanup keeps contains, either at a worktree's HEAD (for example a detached HEAD, reported as `worktree.unintegratedCommits`) or, with scope `all`, on the task branch or a nested writer's branch. Refusals about a nested writer name its `writerId`. A writer branch Claude merged into the task branch counts as integrated while the task branch exists; with scope `all` the task branch goes too, so both need their commits held elsewhere, for example after you merge or push the task branch. A writer branch Claude did not merge refuses scope `all` but not scope `worktree`, which keeps it. Another task branch at the same commits counts only while it exists: cleanups of one repository, from any of its checkouts, run one at a time, so the last branch holding them is refused. Integrate the work (merge or push the branch, commit the changes), use scope `worktree` to keep the branches, or, only when the user has decided the work is not wanted, repeat with `discardUnintegrated: true` to delete it. Never pass that on your own judgment.
- `planned`: a dry run found nothing blocking.
- `cleaned`: every planned resource is gone.
- `partial`: some removals failed; `failures` names each resource and how Git failed. Call `cleanup_task` again later; resources already gone are reported as `already_removed`.

Only the worktrees and branches of the task and its nested writers are removed: never your checkout, other worktrees, remotes, or the task's results and session. `task_result` keeps returning the results after cleanup, and `task_status` shows `workspace.state`, and each nested writer's `workspace.state`, as `removed` or `branch_kept` (the branch remains; start a new writing task with it as `baseline` to continue from it). Repeating `cleanup_task` is safe. Read-only tasks own nothing to clean up (`no_workspace`).

## Parallel tasks and execution slots

Start independent assignments as separate tasks, each with its own `requestKey`, and keep working while they run. Each writing task gets its own worktree and branch, so parallel writers never share files; another caller's tasks never share yours, even with the same key. Retrying a start with the same key returns the existing task and takes no extra slot.

The service runs at most `maxConcurrentExecutions` executions at once (`config.json`, default 2) across all projects and callers; each running execution holds one slot until it ends, whatever it waits for meanwhile. Other executions stay `queued` with `reason: waiting_for_slot`, `detail.position` (1 starts next), and `detail.limit`, and start in the order they began waiting as slots free up, whether the running execution completed, failed, or was cancelled. A follow-up queued behind its own task's execution joins that line only when the execution ends. `list_tasks` returns `slots`: `limit` (`null` while `config.json` is invalid), `running`, and `queued` (executions waiting for a slot). A queued task is not stalled: `wait_task` keeps waiting through it, and `read_output` shows when it started (`Running.`). Cancel queued work you no longer need to free its place.

The bridge never starts a replacement for a waiting or failed execution and never falls back to another credential source; decide yourself whether to start a new task.

The limit counts executions, not the agents working for them. Nested agents Claude starts inside an execution run in that Claude Code process and take no slot: Claude Code applies its own limits to them, and the guidance to use them only when worthwhile is advice to Claude, not enforcement. Nested writers are separate Claude Code processes, but they run as part of the execution that started them, which keeps its slot while it waits for them, so they take no slot of their own and never wait for one; nothing caps how many an execution starts (see "Nested writers"). No setting caps the total number of agents or Claude Code processes.

## Follow-ups and cancellation

Use `send_followup` to continue the same Claude session: ask a clarifying question about the result, or request an adjustment. Each follow-up is a new execution with its own `executionId` and result; the original result never changes (`task_result` without `executionId` still returns it). Choose a new `requestKey` for each follow-up and reuse it only to retry the same message.

If an execution of the task is still active, the follow-up is queued behind it (`delivery: queued`, `queuedBehind`) and starts when that execution ends; when all slots are taken, it also waits for a slot (`reason: waiting_for_slot`). Follow-ups never interrupt or steer a running turn. Wait for the follow-up's own `executionId`.

If the follow-up fails with `reason: session_unavailable`, Claude Code can no longer resume the session (or the task never reached Claude). The message was not sent to any other conversation. Start a new task whose brief includes what the follow-up needs.

`cancel_task` stops obsolete work: queued follow-ups are cancelled at once, and the running execution is stopped by asking Claude Code to stop its nested agents and then ending Claude Code and any nested writers. `cancellation: confirmed` means Claude Code and the nested writers have exited; `requested` means termination is not confirmed yet, so check again with `task_status`. An execution that finished before the cancellation took effect keeps its result. Repeating the call is harmless. Cancellation stops Claude; it does not undo changes Claude already made. You can send a new follow-up to the session after cancelling. Each execution lists its nested agents with a `termination`: `reported` (Claude Code reported the agent stopped), `process_exit` (it ended with Claude Code's process without being reported), or `unconfirmed` (it may still run). `controlGap` is present when Claude Code did not report stopping some of them; tell the user when it matters. The bridge never controls work nested agents started outside Claude Code, such as background commands.

## Nested agents

In read-only tasks, Claude may start nested agents with its Agent tool for independent research or review subtasks, when the gain in quality or elapsed time justifies the extra usage and coordination; its instructions keep small, sequential, or tightly coupled work local. Nested agents get the same read-only tool policy: Claude Code applies the task's disabled edit tools to them too, whatever agent type Claude picks. You do not ask for nested agents, and they are not Codex collaboration agents: you interact only with the task. To keep a task small and cheap, say so in the brief.

Claude remains accountable for nested work and incorporates it into its own result; the bridge records each nested agent separately and never merges or invents results. `task_status` lists them per execution as `nested`: `taskId`, `description`, `agentType`, `background`, `depth` and `parentToolUseId` (which nested agent's `toolUseId` started it; absent when Claude did), `status` (`running`, `completed`, `failed`, `stopped`, `unknown`), Claude Code's `summary`, and `termination`. `read_output` shows their starts, tool calls, progress, and ends as `nested` events.

When Claude finishes its turn while nested agents it started still run, the execution stays `running` with `reason: waiting_for_children` and `detail.runningNested`. It is not complete: Claude continues when they end and its later result becomes the task result. `wait_task` keeps waiting through this state. If Claude Code exits while nested agents still run, the execution fails with `provider_error` rather than reporting a completed assignment. If nested agents never end, the execution waits until you cancel it.

## Nested writers

In a writing task, Claude Code's Agent tool is disabled, because its agents would share Claude's worktree. Instead, Claude may start **nested writers** through tools the bridge gives it: each is a separate Claude Code run that the bridge itself starts in a new worktree, on its own GitFlow branch (the task's `branchType`), from the commit Claude's worktree has checked out. Claude must commit the state a writer starts from; an uncommitted worktree is refused. The bridge chooses each writer's working directory, so the assignment is enforced by the bridge rather than by the prompt; like the task worktree, it isolates Git changes and is not a sandbox. Nested writers have no Agent tool and cannot start nested writers.

Claude assembles their work: it merges or cherry-picks each writer's branch into the task branch, runs the checks that matter, and reports conflicts it could not resolve in `failures`. The execution is not complete while nested writers run: if Claude's turn ends first, the execution stays `running` with `reason: waiting_for_children` (`detail.runningNested` counts nested agents and writers), and Claude is prompted to assemble their work once they have all ended. Claude is prompted the same way when writers ended before its turn did without it collecting their reports.

`task_status` lists them per execution as `nestedWriters`: `writerId`, `status` (`running`, `completed`, `failed`, `cancelled`, `interrupted`), `reason` (a failure reason, `workspace_error`, `cancelled`, `parent_ended` when the execution ended first, or `service_restarted` with `recovery` as for executions; see "After a service restart"), `assignment` (cut at 200 characters), `workspace` (`path`, `branch`, `baseline`, `commitCount`, `changedFileCount`, and `state`, `removed` or `branch_kept`, once `cleanup_task` removed it), and an `error` when it failed (`message` and `action` composed like an execution's, with only the counts of its commits and files). Their commits, changed files, and own results (with `checks`) are in `task_result` of that execution, whether it completed, failed, or was cancelled; an interrupted writer records only its `path`, `branch`, and `baseline`, without counts or lists, so inspect its worktree with git. After the execution's own result, `nestedWriters` lists each writer's `writerId`, `status`, `reason`, `baseline`, `path`, `branch`, its `result` once its summary is shown, and `workspace` (`commits`, `changedFiles`), all within the same `maxChars` pages. Continuation `parts` of a writer carry its `writerId`; the first, with `field: "nestedWriters"`, holds the branch as `text` and the rest in `writer`. Their worktrees and branches are kept after completion, failure, and cancellation, so unintegrated work remains available: review a branch that Claude did not merge before deciding what to do with it. `cleanup_task` removes them with the task's own, under the same rules (see "Cleaning up a writing task"). `read_output` shows their progress as `nested` events prefixed with the `writerId`.

A nested writer may ask questions and permission requests like Claude itself. They appear in the task's `requests` with the executor's `executionId`, the writer's `writerId`, and its `sessionId`, and put that execution in `needs_input`; answer them with `respond_to_request` as usual. They expire when the writer ends. The tools Claude uses to start and collect nested writers never ask for approval.

Limits: the bridge does not limit how many nested writers Claude starts, and they take no execution slot: they run as part of Claude's execution, which holds its slot while they run, so `maxConcurrentExecutions` does not bound them. Each is a full Claude Code session on the same subscription, so they share its usage limits and add to its cost. Claude's instructions ask it to use nested writers only for independent changes large enough to justify that cost; this is guidance, not enforcement. To keep a task small and cheap, say so in the brief.

## Questions and permission requests

Claude works autonomously with the tools the task profile grants; using them needs no approval from you. It stops to wait only for two things:

- a **question** (`kind: question`), when it needs a decision it cannot reasonably make itself;
- a **permission request** (`kind: permission`) before calling a tool of an MCP server configured in the bridge's `config.json`, unless that server sets `autoApprove: true`.

While Claude waits, the execution stays `running` with `reason: needs_input` and `detail.requestId`, and `wait_task` returns. `task_status` lists the task's `requests`: the `question` (questions with their options) or the `action` (the tool, its MCP server, and its input, as Claude wrote it), the `state` (`pending`, `answered`, `expired`), `live`, and for a live request the `responseShape` to use. Answer with `respond_to_request`:

- a question: `{ "answers": { "<question text>": "<option label or your own answer>" } }`, one answer per question keyed exactly as `responseShape` shows it: the question text, with ` (question N)` appended when an earlier question has the same text, several labels comma-separated for a multi-select question;
- a permission request: `{ "decision": "allow" }`, or `{ "decision": "deny", "message": "why" }`.

Claude continues as soon as the response arrives; wait for the same execution again. A lost response is safe to retry: repeating the same response returns the recorded outcome (`repeated: true`) and never applies it twice. A different response to an answered request fails.

A tool being available to Claude is not authority to use it. Answer or approve on your own only what the user's instructions already cover: a question about the assignment you can settle from its brief and context, or an action the user asked for. When a request needs a decision the user has not made, such as a tool call with effects outside the assignment, ask the user and relay their answer. Deny with a `message` rather than leaving Claude waiting when the action is not wanted; Claude then continues without it.

A request is answerable only while `live` is true. When the Claude session that asked ends (completion, failure, cancellation, or a bridge service restart), its pending requests become `expired` and cannot be answered. Send a follow-up with the answer instead. Cancelling a task expires its pending requests the moment cancellation starts, even while nested agents are still being stopped, and Claude is told the request was declined.

## Reading progress

Read progress only when it helps you decide something, such as whether a long task is on track. `read_output` returns the execution's events after a cursor: status changes, Claude's messages, the tools it called with their inputs, and the final summary. Keep reads small: start with the default `limit` and `maxChars`, pass the returned `nextCursor` as `after` to continue (cursors stay valid after reconnecting), and stop when `hasMore` is false. An event cut to fit `maxChars` is marked `truncated`; read just that event in full with `after` set to its `seq` minus 1, `limit: 1`, and a larger `maxChars`. `lastEventSeq` from `wait_task` tells you whether anything new arrived. Only the newest events of long executions are kept (`retention` says how many were dropped); results are never affected.

In read-only tasks, Claude and its nested agents run with the edit tools disabled, but shell commands remain available for inspection. This is a tool policy, not a sandbox: the bridge compares the checkout (HEAD, staged, and working files) before and after the task and lists any change in `result.workspace.modifiedFiles` and `result.failures`, or, when the execution failed or was cancelled and `result` is `null`, in `detail.modifiedFiles`. Writing tasks report their changes in `workspace.changedFiles` and `workspace.commits` instead, in `result.workspace` when completed. When failed, cancelled, or interrupted, `detail.workspace` shows only their counts (`commitCount`, `changedFileCount`); to list them, `task_result` of that execution returns `result: null` with a top-level `workspace` paged like a result (follow `truncated.next`). Results list at most the first 500 commits and changed files; the worktree holds all of them.

## Reading status and results

- `queued`, `running`: in progress. `reason: waiting_for_slot` means a queued execution waits for one of the service's execution slots (see "Parallel tasks and execution slots"). `reason: waiting_for_capacity` means Claude Code is waiting for subscription capacity (`detail.resetsAt` is a Unix time when known); the task continues on its own. `reason: waiting_for_children` means Claude's turn ended while nested agents or nested writers still run; the result is not ready yet. `reason: needs_input` means Claude waits for your response to `detail.requestId` (see above); the task does not continue until you answer, deny, or cancel. When several apply, `reason` shows the most pressing: `needs_input`, then `waiting_for_capacity`, then `waiting_for_children`.
- `completed`: `task_result` has `summary`, `evidence`, `failures`, `remainingWork`, and `workspace`. Claude's own content there and in requests, events, and nested work is shown as Claude produced it, unmasked, so it may quote credentials Claude read; only the bridge's own diagnostics are kept free of copied text.
- `failed`: `reason` is `authentication` (not a verified subscription login, detected before the brief is sent, or an authentication error from Claude Code), `subscription_limit`, `invalid_request` (for example an unavailable model), `session_unavailable` (a follow-up whose session cannot be resumed), `workspace_error` (a writing task's worktree could not be created), or `provider_error`. `error.message` reads `Execution failed with <reason>: <cause>.` The cause is composed by the bridge: a check it made before sending anything (no verified subscription login, a model Claude Code does not offer, no session to continue, Claude Code not found, a worktree that could not be created), the error code or result subtype Claude Code reported, the exit code or signal of its process, nested agents still running when Claude Code exited, or a timeout. For `subscription_limit` the message adds when capacity resets, when known; if a read-only task changed the checkout, it gives the number of files, listed in `detail.modifiedFiles`; for a writing task, it gives the number of commits and changed files in its worktree, which `task_result` of that execution lists. It never contains Claude Code's own output. Relay `error.message` and `error.action`. Before Claude Code has started a session, the action says how to fix what was checked: fix the credential setup or sign in, choose a model from the readiness `models`, start a new task with the context a follow-up needs, install Claude Code, check that the repository accepts new worktrees, call `readiness`, or run `claude` in the project to check that it starts and is signed in. Once a session exists, the action always includes how to see Claude Code's full output: run `claude` in the project and `/resume` the task's `sessionId` (or pick the task's session when no `sessionId` is reported). It also says to `/login` for `authentication`, to wait for the reset and start a new task with a new request key for `subscription_limit`, and otherwise to start a new task with a new request key once the problem is fixed. Do not resubmit in a loop.
- `cancelled`: stopped by `cancel_task`; `detail.processExited` confirms Claude Code exited, and each nested writer without `processExited: false` has exited too.
- `interrupted`: the bridge service stopped while the execution ran (`reason: service_restarted`). See "After a service restart".

## After a service restart

When the bridge service crashes or the machine restarts, the next service recovers the unfinished work before it answers you. Task identities, results of finished executions, progress, sessions, and worktrees survive; nothing is rerun on the bridge's initiative.

- Queued work that had not started stays `queued` and starts on its own (`read_output` shows `it stays queued`). After a machine restart it is `interrupted` instead, because the bridge cannot be sure it had not started.
- An execution that had started is `interrupted`. `detail.recovery.process` says what became of its Claude Code process: `stopped` (it still ran and the bridge ended it), `ended` (it was already gone), `none` (Claude Code had not been launched, so nothing ran), or `unknown` (the bridge cannot prove whether it still runs; tell the user when it matters). Claude may have been partway through a step: an edit, commit, push, or pull request may or may not have happened.
- For a writing task, the bridge then records what the execution left: `detail.recovery.reconciled` is `false` until it is done and `true` after. Then `detail.workspace` gives the worktree's commit and changed-file counts, and `task_result` of that execution lists them in pages; for a publishing task `detail.publication` shows what the remote holds (`task_status` also shows the task's `publication`). Wait with `task_status` until `reconciled` is `true` before deciding; if the service restarts meanwhile, the next one finishes it. When `detail.recovery.worktree` is `unreadable`, Git could not read the worktree, so neither its changes nor the remote were recorded: inspect it with `git -C <path> status` and `git log`, and check the remote yourself. When it is `missing`, Git has no worktree at the recorded path, because the execution never created it or it was removed; the task's events say whether its branch remains. The bridge only reads the remote.
- Pending requests are `expired` and cannot be answered; include the answer in a follow-up. Nested agents of an ended or stopped process are `stopped` with termination `process_exit`; nested writers are `interrupted` with their own `recovery`, and their worktrees and branches are kept.

To continue interrupted work, review what it left (the worktree with `git -C <path> status` and `git log`, and `publication`), then send one `send_followup` to the same task saying what remains. It resumes the Claude session as far as Claude Code recorded it; the interrupted turn is not replayed. The response's `resumes` names the interrupted execution, and Claude is told it was interrupted and to check the current state rather than repeat what already took effect. If the follow-up fails with `session_unavailable`, or recovery says `none`, start a new task with a new request key and the context it needs. Never resubmit the same work repeatedly, and never ask for publication again before checking `publication`: an interrupted execution may already have pushed or opened a pull request.

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
- `maxConcurrentExecutions`: how many executions run at once, a positive integer (default 2). An edit applies the next time work is queued or ends, or `list_tasks`, `task_status`, or `wait_task` is called; running executions are never stopped for it.
- `mcpServers`: MCP servers Claude may use, in Claude Code's `mcpServers` format. Readiness reports each configured server by name and status only, never its configuration or its error text; the user can see a connection error by running `claude` in a terminal and inspecting `/mcp`. Each call to their tools waits for your approval unless the server entry sets `"autoApprove": true`. The name `codex_claude_bridge` is reserved for the bridge's own tools.

The service reads the file on every check, so edits apply without a restart.
