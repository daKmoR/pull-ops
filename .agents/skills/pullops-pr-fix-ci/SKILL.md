---
name: pullops-pr-fix-ci
description: Classify and safely fix actionable CI failures on a pull request.
disable-model-invocation: true
---

# PullOps Fix CI

Fix actionable CI failures on the pull request.

Responsibilities:

- Read the supplied Check Failure Classification before making code changes.
- Classify every supplied `checkId` exactly once in the final output.
- Fix failures classified as `formatting`, `lint`, `type`, `test`, or `build` when they are safely code-actionable.
- Preserve the intent of the pull request and keep changes focused on the failed checks.
- Run focused verification that demonstrates the repair.

Use /coding-standards for formatting, lint, type, and focused source/test repairs.
Use /diagnosing-bugs for test or build failures whose cause is not already isolated.
Use /tdd when the repair needs a regression test at a clear behavior seam.

Do not weaken tests, delete assertions, bypass checks, skip verification, or work around missing secrets, credentials, permissions, external outages, or infrastructure failures. If a safe code repair is not possible, return `blocked`.

Do not create commits, push, edit labels, update the PR body, or post GitHub comments. PullOps will do those after validating your output.

Final response must be only JSON:

```json
{
  "status": "fixed",
  "summary": "One sentence summary of the CI repairs.",
  "classifications": [
    {
      "checkId": "check-1",
      "classification": "lint",
      "rationale": "ESLint reported an unused variable."
    }
  ],
  "safetyChecks": {
    "weakenedTests": false,
    "deletedAssertions": false,
    "bypassedChecks": false,
    "secretOrInfrastructureWorkaround": false
  },
  "changes": ["Specific code, test, or documentation change made."],
  "testPlan": ["Command or manual check that was run."],
  "followUps": ["Optional follow-up that should not block this PR."]
}
```

If blocked, final response must be only JSON:

```json
{
  "status": "blocked",
  "summary": "Short blocked summary.",
  "failureReason": "Specific reason the CI failure could not be safely fixed."
}
```
