---
name: pullops-pr-address-review
description: Address PullOps PR feedback and return structured review-response output.
disable-model-invocation: true
---

# PullOps Address Review

Address all supplied Actionable PR Feedback on the PullOps-managed pull
request. The feedback list is the operation boundary; the linked issue or Spec
is context for deciding whether each request belongs in this PR.

## Address

1. Inspect the linked issue or Spec context, PR body, diff, changed files, and
   supplied Actionable PR Feedback before editing. Completion criterion: every
   supplied `feedbackId` has a planned disposition: `addressed`, `declined`, or
   `deferred`.
2. Address feedback by default with code, tests, documentation, or explanation
   changes as needed. Use `declined` only when the requested change should not
   be made, and use `deferred` only when the feedback is stale, irrelevant, or
   outside this PR. Completion criterion: every declined or deferred item has a
   substantive reason tied to the linked issue, current diff, or PR scope.
3. Use the appropriate discipline:
   - Use `coding-standards` before editing source files, tests, public APIs, or types.
   - Use `tdd` where feedback requires new behavior coverage at a clear seam.
   - Use `diagnosing-bugs` when feedback reports broken, failing, throwing, flaky, or slow behavior and no tight reproduction exists yet.
   Completion criterion: every referenced discipline needed for the feedback
   has been applied before the relevant edits.
4. Keep changes focused on the linked issue and supplied feedback. Record
   unrelated defects, broad refactors, and larger design problems as `followUps`
   instead of folding them into this operation. Completion criterion: the
   working tree contains only feedback-focused work or necessary adjacent work.
5. Run focused verification appropriate for the changes. If automated
   verification is unavailable, perform the tightest manual check available and
   say exactly what was checked in `testPlan`. Completion criterion: `testPlan`
   names verification that was actually run, or the focused manual check used
   when automated verification was unavailable.

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

Heartbeats must originate from this address-review agent process, not from the parent PullOps CLI.

PullOps boundary: use referenced skills for their discipline only. Do not ask the
user, emit non-JSON, commit, push, approve, request changes, edit labels, update
the PR body, post GitHub comments, or leave the supplied feedback scope. PullOps
handles GitHub mutations after validating your output.

Completion criteria:

- The set of `feedbackId`s across `addressed`, `declined`, and `deferred`
  exactly equals the supplied `feedbackId` set.
- `addressed` items state the concrete response.
- `declined` and `deferred` items state substantive reasons.
- `changes` names concrete code, test, documentation, or explanation edits.
- `testPlan` names verification that was actually run, or the focused manual
  check used when automated verification was unavailable.

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
