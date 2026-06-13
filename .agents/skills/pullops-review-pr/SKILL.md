---
name: pullops-review-pr
description: Review a PullOps-managed PR and return a structured Review Result.
---

# PullOps Review PR

Review the PullOps-managed pull request against its linked issue or PRD context.

Responsibilities:

- Check that the PR satisfies the linked issue or PRD.
- Perform the Coding Standards Pass for this repository.
- Inspect the diff, PR comments, review summaries, and unresolved review threads.
- Publish actionable review feedback through the structured Review Result only.
- Make small direct improvements when they clearly belong to review, such as local coding-standards cleanup.

Do not create commits, push, approve, request changes, edit labels, or update the PR body. PullOps will do those after validating your output.

Inline comments must use changed lines from the supplied diff. Replies must use `commentId` values from unresolved review threads.

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

Use `approved` when the PR is ready for the next PullOps automation step. Use `changes_requested` when `pullops-address-review` should handle actionable feedback.

If blocked, final response must be only JSON:

```json
{
  "status": "blocked",
  "summary": "Short blocked summary.",
  "failureReason": "Specific reason the review could not be completed."
}
```
