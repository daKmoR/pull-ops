---
name: pullops-implement-issue
description: Implement a PullOps Leaf Issue or manually selected PRD sub-issue and report structured implementation output for the CLI.
---

# PullOps Implement Issue

Implement the linked Leaf Issue or manually selected PRD sub-issue as written.

When the prompt identifies a parent PRD Issue, use it as context, but keep the
implementation focused on the selected sub-issue. Do not silently implement
sibling sub-issues or parent PRD scope.

Allowed scope:

- Make the code, test, documentation, and configuration changes needed to satisfy the issue.
- Include Adjacent Work when it is necessary for the issue to work correctly.
- Add or update focused tests at the seam that proves the behavior.

Do not silently fold unrelated defects, broad refactors, or larger design problems into the PR. Record those as follow-up candidates instead.

Before finishing:

- Run focused verification that matches the touched behavior.
- Run broader verification when the change affects shared seams.
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
