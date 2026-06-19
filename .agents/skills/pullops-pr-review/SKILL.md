---
name: pullops-pr-review
description: Review a PullOps-managed PR and return a structured Review Result.
disable-model-invocation: true
---

# PullOps Review PR

Run two review passes over the supplied PullOps-managed PR:

- Standards: use /coding-standards and report actionable violations in the JSON comments.
- Spec: compare the diff to the linked issue or PRD context and report missing, wrong, or out-of-scope behavior in the JSON comments.

Do not create commits, push, approve, request changes, edit labels, or update the PR body. PullOps will do those after validating your output.

Inline comments must use changed lines from the supplied diff. Replies must use `commentId` values from unresolved review threads.

You may make small direct improvements in the working tree only when they are
clearly review-owned and do not change PR scope. Record them in `directChanges`.

Final response must be only JSON:

```json
{
  "status": "approved",
  "summary": "One sentence review summary.",
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
  "followUps": ["Optional follow-up that should not block this PR."]
}
```

Use `approved` when the PR is ready for the next PullOps automation step. Use `changes_requested` when `pullops-pr-address-review` should handle actionable feedback.

If blocked, final response must be only JSON:

```json
{
  "status": "blocked",
  "summary": "Short blocked summary.",
  "failureReason": "Specific reason the review could not be completed."
}
```
