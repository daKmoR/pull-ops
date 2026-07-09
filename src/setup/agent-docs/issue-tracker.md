# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues. Upstream authoring skills like `to-spec` and `to-tickets` should publish through PullOps issue commands. Use the `gh` CLI for read, list, comment, label, and close operations.

## Conventions

- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`
- **Dependencies**: express blocking relationships in the issue body with `Blocked by: #<issue>`. PullOps treats only closed issues as satisfying that dependency.
- **Sub-issues**: use GitHub native sub-issues for Spec breakdowns and parent-ticket relationships.
- **AFK-ready triage**: apply `ready-for-agent` only when the issue is fully specified, dependencies are recorded, and an agent can continue without more clarification.

Infer the repo from `git remote -v` - `gh` does this automatically when run inside a clone.

## When a skill says "publish to the issue tracker"

Write the normalized request as structured JSON, save it to a file for auditability and context recovery, and publish it with the matching PullOps command:

Before publishing with PullOps, read and follow [PullOps CLI command form](pullops-cli.md).

- **Spec publication**: `npm_config_cache=/tmp/pullops-npm-cache npm exec -- pullops issues publish-spec --file <path>`
- **Ticket batch publication**: `npm_config_cache=/tmp/pullops-npm-cache npm exec -- pullops issues publish-tickets --file <path>`
- **Concrete Issue publication**: `npm_config_cache=/tmp/pullops-npm-cache npm exec -- pullops issues publish-issue --file <path>`

Published specs and ticket payloads should preserve GitHub-native parent/sub-issue structure and any `Blocked by: #<issue>` lines needed for sequencing.

stdin is supported, but `--file <path>` is the documented path and should be the default handoff from upstream authoring skills.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>` for the diff.
- **List external PRs for triage**: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments` then keep only `authorAssociation` of `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE` (drop `OWNER`/`MEMBER`/`COLLABORATOR`).
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either - resolve with `gh pr view 42` and fall back to `gh issue view 42`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. `gh issue create --label wayfinder:map`.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue (`gh api` on the sub-issues endpoint). Where sub-issues aren't enabled, add the child to a task list in the map body and put `Part of #<map>` at the top of the child body. Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: GitHub's **native issue dependencies** — the canonical, UI-visible representation. Add an edge with `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where `<blocker-db-id>` is the blocker's numeric **database id** (`gh api repos/<owner>/<repo>/issues/<n> --jq .id`, _not_ the `#number` or `node_id`). GitHub reports `issue_dependencies_summary.blocked_by` (open blockers only — the live gate). Where dependencies aren't available, fall back to a `Blocked by: #<n>, #<n>` line at the top of the child body. A ticket is unblocked when every blocker is closed.
- **Frontier query**: list the map's open children (`gh issue list --state open`, scoped to the map's sub-issues / task list), drop any with an open blocker (`issue_dependencies_summary.blocked_by > 0`, or an open issue in the `Blocked by` line) or an assignee; first in map order wins.
- **Claim**: `gh issue edit <n> --add-assignee @me` — the session's first write.
- **Resolve**: `gh issue comment <n> --body "<answer>"`, then `gh issue close <n>`, then append a context pointer (gist + link) to the map's Decisions-so-far.
