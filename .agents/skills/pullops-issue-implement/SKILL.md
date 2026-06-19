---
name: pullops-issue-implement
description: Implement one PullOps Concrete Issue or manually selected Child Issue and report structured implementation output for the CLI.
disable-model-invocation: true
---

# PullOps Implement Issue

Use /implement

- Leave committing, pushing, labels, and PR creation to PullOps.

Final response must be only JSON:

```json
{
  "status": "implemented",
  "summary": "One sentence summary of the completed implementation.",
  "changes": ["Specific code, test, or documentation change."],
  "testPlan": ["Command or manual check that was run."],
  "followUps": ["Optional follow-up that should not be folded into this issue."]
}
```

If blocked, final response must be only JSON:

```json
{
  "status": "blocked",
  "summary": "Short blocked summary.",
  "failureReason": "Specific reason the issue could not be implemented."
}
```
