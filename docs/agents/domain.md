# Domain docs

## Layout

This repository uses a single-context layout:

- `CONTEXT.md` at the repository root holds domain terms and their meanings.
- `docs/adr/` holds architecture decision records.

## Before exploring the codebase

Read root `CONTEXT.md` and any ADRs relevant to the area being explored.

If these documents do not exist, proceed silently. The `domain-modeling`
skill creates them when domain terms or decisions are resolved.

## Use domain vocabulary

Use the terms defined in `CONTEXT.md` when naming concepts in issues,
proposals, hypotheses, and tests. Respect any synonyms it explicitly avoids.

If a concept is missing, reconsider whether it belongs to the project.
Record a real vocabulary gap for `domain-modeling`.

## Surface ADR conflicts

If a proposal contradicts an existing ADR, identify the ADR and explain
why the decision should be reconsidered.
