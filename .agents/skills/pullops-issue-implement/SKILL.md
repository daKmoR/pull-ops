---
name: pullops-issue-implement
description: Implement one PullOps Concrete Issue or manually selected Child Issue and report structured implementation output for the CLI.
disable-model-invocation: true
---

# PullOps Implement Issue

Implement the supplied issue as written.

- Leave committing, pushing, labels, and PR creation to PullOps.
- Use /coding-standards before editing source files, tests, public APIs, or types.
- Use /tdd where the issue has a clear behavior seam that can be covered incrementally.
- Use /diagnosing-bugs when the issue is bug-shaped and no tight reproduction exists yet.
- Keep changes focused, allowing only adjacent work needed to complete the issue correctly.
- Run focused verification that is appropriate for the change.

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
