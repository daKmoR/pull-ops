# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues. Upstream authoring skills like `to-prd` and `to-issues` should publish through PullOps issue commands. Use the `gh` CLI for read, list, comment, label, and close operations.

## Conventions

- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v` - `gh` does this automatically when run inside a clone.

## When a skill says "publish to the issue tracker"

Write the normalized request as structured JSON, save it to a file for auditability and context recovery, and publish it with the matching PullOps command:

Before publishing with PullOps, read and follow [PullOps CLI command form](pullops-cli.md).

- **PRD publication**: `npm_config_cache=/tmp/pullops-npm-cache npm exec -- pullops issues publish-prd --file <path>`
- **Child Issue batch publication**: `npm_config_cache=/tmp/pullops-npm-cache npm exec -- pullops issues publish-children --file <path>`
- **Concrete Issue publication**: `npm_config_cache=/tmp/pullops-npm-cache npm exec -- pullops issues publish-issue --file <path>`

stdin is supported, but `--file <path>` is the documented path and should be the default handoff from upstream authoring skills.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>` for the diff.
- **List external PRs for triage**: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments` then keep only `authorAssociation` of `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE` (drop `OWNER`/`MEMBER`/`COLLABORATOR`).
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either - resolve with `gh pr view 42` and fall back to `gh issue view 42`.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.
