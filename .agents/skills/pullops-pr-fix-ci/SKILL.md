---
name: pullops-pr-fix-ci
description: Classify and repair safe code-actionable CI failures on a pull request.
disable-model-invocation: true
---

# PullOps Fix CI

Repair code-actionable failed checks on the pull request. The supplied Check
Failure Classification is the operation boundary; the linked issue or PRD, PR
body, changed files, and diff are context for keeping the repair in scope.

## Fix

1. Inspect the supplied Check Failure Classification, linked issue or PRD, PR
   body, changed files, and diff before editing. Completion criterion: every
   supplied `checkId` has been copied into a local check ledger with its
   supplied classification, actionable status, and rationale.
2. Preserve the classification ledger. Do not reclassify checks. Completion
   criterion: the final `classifications` array will echo every supplied
   `checkId` exactly once with its supplied classification and a non-empty
   rationale, with no omitted, duplicated, or invented check IDs.
3. Decide repairability before changing code. Fix only failures classified as
   `formatting`, `lint`, `type`, `test`, or `build` when they are safely
   code-actionable. Return `blocked` for `environment`, `flaky`, or `secret`
   failures, or when a safe code repair cannot be inferred from the supplied
   context. Completion criterion: every actionable check has a focused repair
   plan, or the output is blocked with a specific reason.
4. Use the appropriate discipline:
   - Use `coding-standards` for formatting, lint, type, and focused source/test repairs.
   - Use `diagnosing-bugs` for test or build failures whose cause is not already isolated.
   - Use `tdd` when the repair needs a regression test at a clear behavior seam.
   Completion criterion: every referenced discipline needed for the failed
   checks has been applied before the relevant edits.
5. Keep the patch scoped to the failed checks and the pull request diff.
   Preserve the intent of the pull request. Record unrelated defects, broad
   refactors, and larger design problems as `followUps` instead of folding them
   into this operation. Completion criterion: the working tree contains only CI
   repair changes or necessary adjacent work.
6. Run focused verification that demonstrates the repair. If automated
   verification is unavailable, perform the tightest manual check available and
   say exactly what was checked in `testPlan`. Completion criterion: `testPlan`
   names verification that was actually run, or the focused manual check used
   when automated verification was unavailable.
7. Run the safety audit before returning `fixed`. Completion criterion:
   `safetyChecks.weakenedTests`, `deletedAssertions`, `bypassedChecks`, and
   `secretOrInfrastructureWorkaround` are all `false`. If any would be `true`,
   return `blocked` instead.

## Completion Criteria

- The `classifications` array exactly equals the supplied `checkId` set.
- Each output classification matches the supplied classification for that
  `checkId`.
- `changes` names concrete code, test, documentation, or explanation edits.
- `testPlan` names verification that was actually run, or the focused manual
  check used when automated verification was unavailable.
- `safetyChecks` are all `false` for a `fixed` result.

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

Heartbeats must originate from this CI-fix agent process, not from the parent PullOps CLI.

PullOps boundary: use referenced skills for their discipline only. Do not ask the
user, emit non-JSON, commit, push, edit labels, update the PR body, post GitHub
comments, or leave the failed-check scope. PullOps handles GitHub mutations
after validating your output.

Do not weaken tests, delete assertions, bypass checks, skip verification, or
work around missing secrets, credentials, permissions, external outages, or
infrastructure failures. If a safe code repair is not possible, return
`blocked`.

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
