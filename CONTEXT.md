# Codex-Claude Delegation

The language of delegating work from Codex to Claude Code and returning results to the parent.

## Language

**Parent agent**:
The Codex agent responsible for planning, delegating, reviewing, verifying, and integrating work toward the user's goal. Also called the coordinator.

**Child agent**:
A Claude Code agent trusted to carry out an assigned task autonomously using the tools available to it. Also called the executor; the parent agent remains responsible for coordination and integration.
_Avoid_: Native Codex subagent

**Delegated task**:
A bounded assignment from the parent agent to a child agent, with an expected result.

**Execution**:
One run of Claude Code for a delegated task, with its own identity, status, and result. The first execution carries the original assignment.

**Request key**:
A caller-chosen key that identifies one request so a retry returns what the first attempt created: a start request within a project and logical caller returns the existing task, and a follow-up within a task returns the existing execution.

**Logical caller**:
The identity that owns delegated tasks across MCP connections, such as one Codex installation. A reconnecting parent agent finds the tasks it started as the same logical caller.

**Task profile**:
The tools and workspace a child agent gets for a delegated task. The read-only profile inspects a shared checkout without edit tools; it is a tool policy, not a sandbox. The writing profile works in a task worktree with all tools except nested agents.

**Task worktree**:
The Git worktree and task branch a writing agent works in, created from a committed baseline. It isolates Git changes from other agents; it is not a sandbox.

**Task result**:
The outcome of delegated work, including findings or code changes, verification evidence, and any associated pull request.

**Writing agent**:
A child agent assigned to change project files as part of its delegated task.

**Nested agent**:
An agent engaged by a child agent to carry out part of its delegated task. The child agent remains accountable for incorporating that agent's work into its task result.

**Bridge service**:
The local background process that owns delegated work, its persisted state, and the Claude Code processes. MCP entry points connect to it and may come and go without affecting it.
_Avoid_: Daemon, server

**State directory**:
The per-user directory whose database, socket, token, configuration, and logs belong to exactly one bridge service at a time.

**Readiness**:
Whether Claude Code can take delegated work: a compatible executable, a verified subscription login, available models, Git support, and reachable configured integrations.
