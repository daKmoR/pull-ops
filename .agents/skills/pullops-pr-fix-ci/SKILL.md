---
name: pullops-pr-fix-ci
description: Classify and safely fix actionable CI failures on a pull request.
disable-model-invocation: true
---

# PullOps Fix CI

Fix actionable CI failures on the pull request.

Responsibilities:

- Read the supplied Check Failure Classification before making code changes.
- Echo every supplied `checkId` exactly once with its supplied classification and a rationale.
- The `classifications` array must exactly equal the supplied `checkId` set; do not omit, duplicate, invent, or reclassify checks.
- Fix failures classified as `formatting`, `lint`, `type`, `test`, or `build` when they are safely code-actionable.
- Preserve the intent of the pull request and keep changes focused on the failed checks.
- Run focused verification that demonstrates the repair.

Use /coding-standards for formatting, lint, type, and focused source/test repairs.
Use /diagnosing-bugs for test or build failures whose cause is not already isolated.
Use /tdd when the repair needs a regression test at a clear behavior seam.

Liveness: your first tool call after reading this skill must be
`npm exec pullops -- heartbeat --summary "<brief current focus>"`. After that,
repeat the same heartbeat tool call about every 4 minutes while work stays
active or before every fourth non-heartbeat tool call, whichever comes first.
Also heartbeat immediately before any command that may run longer than 4
minutes. If you are unsure whether a heartbeat is due, send it before
continuing.
Heartbeats must come from this CI-fix agent, not from the parent PullOps CLI.

PullOps boundary: use referenced skills for their discipline only. Do not ask the
user, emit non-JSON, commit, push, edit labels, update the PR body, post GitHub
comments, or leave the failed-check scope. PullOps handles GitHub mutations
after validating your output.

Do not weaken tests, delete assertions, bypass checks, skip verification, or work around missing secrets, credentials, permissions, external outages, or infrastructure failures. If a safe code repair is not possible, return `blocked`.

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
