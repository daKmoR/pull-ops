---
name: pullops-pr-address-review
description: Address Actionable PR Feedback on a PullOps-managed PR and return structured pr-address-review output.
disable-model-invocation: true
---

# PullOps Address Review

Address Actionable PR Feedback on the PullOps-managed pull request.

Responsibilities:

- Inspect the linked issue or PRD context, PR body, diff, changed files, and supplied Actionable PR Feedback.
- The set of `feedbackId`s across `addressed`, `declined`, and `deferred` must exactly equal the supplied `feedbackId` set.
- Address feedback by default with code, test, documentation, or explanation changes as needed.
- Decline feedback only when the requested change should not be made, and include a substantive written reason.
- Defer feedback only when it is stale, irrelevant, or outside this PR, and include a reason.
- Keep changes focused on the linked issue and the supplied feedback.

- Use /coding-standards before editing source files, tests, public APIs, or types.
- Use /tdd where feedback requires new behavior coverage at a clear seam.
- Use /diagnosing-bugs when feedback reports broken, failing, throwing, flaky, or slow behavior and no tight reproduction exists yet.

Liveness: your first tool call after reading this skill must be
`npm exec pullops -- heartbeat --summary "<brief current focus>"`. After that,
repeat the same heartbeat tool call about every 4 minutes while work stays
active or before every fourth non-heartbeat tool call, whichever comes first.
Also heartbeat immediately before any command that may run longer than 4
minutes. If you are unsure whether a heartbeat is due, send it before
continuing.
Heartbeats must come from this address-review agent, not from the parent PullOps
CLI.

PullOps boundary: use referenced skills for their discipline only. Do not ask the
user, emit non-JSON, commit, push, approve, request changes, edit labels, update
the PR body, post GitHub comments, or leave the supplied feedback scope. PullOps
handles GitHub mutations after validating your output.

Final response must be only JSON:

```json
{
  "status": "addressed",
  "summary": "One sentence summary of the addressed PR feedback.",
  "addressed": [
    {
      "feedbackId": "thread:123456789",
      "response": "Implemented the requested change."
    }
  ],
  "declined": [
    {
      "feedbackId": "review:PRR_123",
      "reason": "This requested change would contradict the linked issue."
    }
  ],
  "deferred": [
    {
      "feedbackId": "comment:987654321",
      "reason": "This is stale after the latest diff."
    }
  ],
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
  "failureReason": "Specific reason the feedback could not be addressed."
}
```
