# Issue tracker: GitHub

Issues and specs live in GitHub Issues for `vova-white/codex-claude-bridge`.
Use the `gh` CLI through `rtk`. Run commands inside this clone so `gh`
infers the repository from the Git remote.

Write issue titles, bodies, and comments in English. For multiline bodies,
write the exact text to a temporary file and pass it with `--body-file`.

## Operations

- Create: `rtk gh issue create --title "..." --body-file /path/to/body.md`.
- Read, including labels and discussion: `rtk gh issue view <number> --json number,title,body,labels,comments`.
- List: `rtk gh issue list --state open --json number,title,body,labels,comments`. Adjust `--state`, `--label`, and `--limit` to the task.
- Comment: `rtk gh issue comment <number> --body-file /path/to/comment.md`.
- Apply or remove labels: `rtk gh issue edit <number> --add-label "..."` or `--remove-label "..."`.
- Close: `rtk gh issue close <number>` after recording the resolution.

When a skill says "publish to the issue tracker", create a GitHub issue.
When it says "fetch the relevant ticket", read the issue with its labels
and comments.

## Pull requests as a triage surface

**PRs as a request surface: no.**

If enabled, triage external PRs using the same label mapping and states
as issues. Use `rtk gh pr` commands and read the diff with
`rtk gh pr diff <number>`. External contributors have an author association
of `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE`.

GitHub issues and PRs share a number space. If the type of a reference is
unclear, resolve it with `rtk gh pr view <number>` and, if it is not a PR,
`rtk gh issue view <number>`.

## Wayfinding operations

Used by `/wayfinder` when organizing a map and its child tickets.

- Map: one issue labelled `wayfinder:map`, with Notes, Decisions-so-far, and Fog in its body.
- Child ticket: link it to the map as a GitHub sub-issue. If sub-issues are unavailable, add it to a task list in the map and put `Part of #<map>` at the top of its body. Use `wayfinder:<type>` labels: `research`, `prototype`, `grilling`, or `task`.
- Blocking: use native issue dependencies through `rtk gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`. Obtain the database ID with `rtk gh api repos/<owner>/<repo>/issues/<number> --jq .id`. If dependencies are unavailable, record `Blocked by: #<number>` in the child body. A ticket is unblocked when all blockers are closed.
- Frontier: inspect the map's open children in map order. Choose the first unassigned child without open blockers; check `issue_dependencies_summary.blocked_by` or the fallback `Blocked by` references.
- Claim: assign the selected ticket with `rtk gh issue edit <number> --add-assignee @me` as the session's first write.
- Resolve: comment with the result, close the child, and add a brief finding and link to the map's Decisions-so-far.
