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

**Task result**:
The outcome of delegated work, including findings or code changes, verification evidence, and any associated pull request.

**Writing agent**:
A child agent assigned to change project files as part of its delegated task.

**Nested agent**:
An agent engaged by a child agent to carry out part of its delegated task. The child agent remains accountable for incorporating that agent's work into its task result.
