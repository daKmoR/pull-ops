---
name: pullops-pr-review
description: Review a PullOps-managed PR with Standards and Spec passes.
disable-model-invocation: true
---

# PullOps Review PR

Review the supplied PullOps-managed PR. The linked issue or Spec, PR body,
changed files, diff, comments, reviews, and unresolved review threads are the
operation boundary.

## Review

Review along the two `/code-review` axes — that skill carries the review
discipline, including the Fowler smell baseline for the Standards axis:

- **Standards**: does the diff follow this repo's documented coding standards
  (`/coding-standards`)? Report only actionable violations; skip anything
  tooling already enforces.
- **Spec**: does the diff faithfully implement the linked issue or Spec and
  the PR body claims — nothing missing, wrong, or out of scope?

Then map every finding into the output contract:

1. Every finding lands as an inline `comments` item on a changed diff line, a
   review-owned `directChanges` entry, a `replies` item on a matching
   unresolved thread, or the reason for `blocked` — never as loose prose.
2. Reply only when the supplied thread is still unresolved; every
   `replies[].commentId` is a positive integer from the supplied unresolved
   review threads.
3. Make direct review improvements only when they are small, clearly
   review-owned, and do not change PR scope; name every working-tree edit in
   `directChanges`.
4. Decide the result. Use `changes_requested` when actionable feedback should
   be handled by `pullops-pr-address-review`. Use `approved` only when the PR is
   ready for the next PullOps automation step after any direct review changes.
   Use `blocked` only when the review cannot be completed safely from the
   supplied context.
5. With `changes_requested`, propose the next operation via `nextOperation`:
   `pr-address-review` (default) when the problems are review feedback, or
   `pr-fix-ci` when the real blocker is failing checks that should be repaired
   first. PullOps validates the proposal against its transition graph and
   falls back to the default when it is not an allowed continuation.

## Output Rules

- Inline comments must use changed lines from the supplied diff. Non-diff
  comments will be dropped by PullOps, so put only publishable comments in
  `comments`.
- Replies must use `commentId` values from unresolved review threads. Replies
  to stale or unknown IDs will be dropped by PullOps.
- `comments`, `replies`, `directChanges`, `reviewFollowUpIssues`, and
  `followUps` may be empty arrays when there is nothing to report.
- If you are approving the final Escalation Review Cycle, put standalone
  `needs-triage` issue proposals in `reviewFollowUpIssues` with non-empty
  `title` and `body` fields. Keep plain `followUps` as audit-only notes; they
  must not create issues.
- Do not add unsupported top-level fields.

## Liveness and command execution

Use PullOps as the command gate.

Before running any PullOps CLI command, read and follow
[`docs/agents/pullops-cli.md`](../../../docs/agents/pullops-cli.md).

Do not run shell commands directly. For every shell command, use:

```bash
npm_config_cache=/tmp/pullops-npm-cache npm exec -- pullops step "<brief current focus>" -- <command>
```

For commands that may run longer than 4 minutes, use:

```bash
npm_config_cache=/tmp/pullops-npm-cache npm exec -- pullops step --long "<brief current focus>" -- <command>
```

`pullops step` automatically emits heartbeats when needed. Do not manually count time or tool calls for shell commands.

If you are about to make several non-shell tool calls, send a manual heartbeat first:

```bash
npm_config_cache=/tmp/pullops-npm-cache npm exec -- pullops heartbeat --summary "<brief current focus>"
```

Heartbeats must originate from this review agent process, not from the parent PullOps CLI.

PullOps boundary: use referenced skills for their discipline only. Do not ask
the user, emit non-JSON, create commits, push, approve, request changes, edit
labels, update the PR body, post GitHub comments, or leave the review scope.
PullOps handles GitHub mutations after validating your output.

Final response must be only JSON:

```json
{
  "status": "changes_requested",
  "summary": "One sentence review summary.",
  "nextOperation": "pr-address-review",
  "comments": [
    {
      "path": "src/example.js",
      "line": 42,
      "body": "Actionable inline review comment."
    }
  ],
  "replies": [
    {
      "commentId": 123456789,
      "body": "Reply to an unresolved review comment."
    }
  ],
  "directChanges": ["Small direct improvement made during review."],
  "reviewFollowUpIssues": [
    {
      "title": "Follow up on a non-blocking concern.",
      "body": "Standalone Review Follow-up Issue body that links back to the PR and source issue."
    }
  ],
  "followUps": ["Optional follow-up that should not block this PR."]
}
```

If blocked, final response must be only JSON:

```json
{
  "status": "blocked",
  "summary": "Short blocked summary.",
  "failureReason": "Specific reason the review could not be completed."
}
```
