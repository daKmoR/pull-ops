---
name: pullops-pr-finalize
description: Plan an ambiguous PullOps PR Finalize Logical Commit Stack.
disable-model-invocation: true
---

# PullOps PR Finalize

Plan the Logical Commit Stack for an ambiguous PullOps-managed PR. PullOps
invokes this skill only after deterministic PR Finalize cannot safely group the
history itself.

This is a planner, not an operator. Propose commit grouping and commit messages
only. Do not edit files, create commits, reset, stage files, push, edit labels,
update PR bodies, change PR references, touch review state, touch checks, change
draft state, change merge state, post GitHub comments, or merge the pull
request. PullOps validates the Commit Plan, applies the rewrite
deterministically, pushes with force-with-lease, and verifies the final tree
still matches the reviewed tree.

## Liveness

This planner must not run shell commands except the heartbeat command below, so
keep liveness with manual heartbeats instead of `pullops step`.

Before running any PullOps CLI command, read and follow
[`docs/agents/pullops-cli.md`](../../../docs/agents/pullops-cli.md).

Your first tool call after reading this skill must be:

```bash
npm_config_cache=/tmp/pullops-npm-cache npm exec -- pullops heartbeat --summary "<brief current focus>"
```

After that, repeat the same heartbeat tool call about every 4 minutes while work
stays active or before every fourth non-heartbeat tool call, whichever comes
first. If you are unsure whether a heartbeat is due, send it before continuing.

Heartbeats must originate from this finalize-planning agent process, not from
the parent PullOps CLI.

## Plan

1. Inventory the supplied context: Parent Issue, closed native Tickets, PR
   body, changed-file list, changed-file summary, and current commit history.
   Completion criterion: every supplied changed file has been copied into a
   local file ledger exactly as written, and the parent and eligible ticket
   numbers are known.
2. Assign the file ledger. Use the issue context, file summary, PR body, and
   commit history to infer whether each file belongs to a closed native Ticket or
   to explicit Spec-level work. Completion criterion: every changed file
   has exactly one tentative owner, or the result is `blocked` because a safe
   owner cannot be inferred from the supplied information.
3. Group commits from the ledger. Prefer one Ticket Commit per closed
   native Ticket represented by the files. Include parent-level commits
   only for explicit Spec-level files. Completion criterion: every commit has at
   least one file, and every represented owner has the narrowest safe commit.
4. Write commit messages. Completion criterion: every planned commit passes the
   footer rules below and uses a conventional commit header.
5. Run the final ledger check before responding. Completion criterion: the
   concatenated planned commit `files` arrays exactly equal the supplied
   changed-file list; no file is omitted, duplicated, renamed, or invented.

If any completion criterion cannot be met safely, return the blocked JSON shape.

## Commit Plan Rules

- `commitPlan.commits` must contain at least one commit.
- Each commit's `body`, `footers`, and `files` arrays must contain only
  non-empty strings.
- Include `commitPlan.justification` only when grouping is not one commit per
  closed Ticket, and make it a non-empty explanation when included.
- Put non-blocking notes in `followUps`; do not add unsupported top-level
  fields.

## Commit Message Rules

- Use conventional commit headers.
- Use `Refs: #<ticket>` and `Spec: #<parent>` footers for Ticket work.
- Use `Refs: #<parent>` footers for explicit parent-level Spec work.
- Reference only the supplied parent issue and closed native Tickets.
- Do not use GitHub closing keywords in commit footers.

Final response must be only JSON:

```json
{
  "status": "planned",
  "summary": "One sentence summary of the history grouping plan.",
  "commitPlan": {
    "commits": [
      {
        "header": "feat(issue): implement #42",
        "body": ["Explain the logical change in this commit."],
        "footers": ["Refs: #42", "Spec: #7"],
        "files": ["src/example.js", "src/example.test.js"]
      }
    ]
  },
  "followUps": ["Optional follow-up that should not block this PR."]
}
```

If blocked, final response must be only JSON:

```json
{
  "status": "blocked",
  "summary": "Short blocked summary.",
  "failureReason": "Specific reason the history grouping plan could not be produced safely."
}
```
