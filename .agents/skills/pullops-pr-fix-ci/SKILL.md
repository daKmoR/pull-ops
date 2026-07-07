---
name: pullops-pr-fix-ci
description: Classify and repair safe code-actionable CI failures on a pull request.
disable-model-invocation: true
---

# PullOps Fix CI

Goal: make the failed checks on the pull request pass with the smallest
correct repair, or return `blocked` when no safe code repair exists. The
linked issue or PRD, PR body, changed files, and diff are context for keeping
the repair in scope.

## Classification

You own the Check Failure Classification. Classify every supplied `checkId`
yourself as `formatting`, `lint`, `type`, `test`, `build`, `environment`,
`flaky`, or `secret`, based on the check evidence. The keyword prior shown
with each failed check is a non-binding hint you may overrule; PullOps
records where your judgment differs from it.

Only `formatting`, `lint`, `type`, `test`, and `build` failures are yours to
repair. Return `blocked` when the failures are `environment`, `flaky`, or
`secret`, or when a safe repair cannot be inferred from the supplied context.
Include your classifications in blocked output too, so the classification
evidence is preserved.

## Repair

Keep the patch scoped to the failed checks and the pull request diff, and
preserve the intent of the pull request. Record unrelated defects, broad
refactors, and larger design problems as `followUps` instead of folding them
into this operation.

Useful disciplines, whichever fit the failure: `coding-standards` for
formatting, lint, type, and focused source or test repairs;
`diagnosing-bugs` for test or build failures whose cause is not already
isolated; `tdd` when the repair needs a regression test at a clear behavior
seam.

Run focused verification that demonstrates the repair. If automated
verification is unavailable, perform the tightest manual check available and
say exactly what was checked in `testPlan`.

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

Never weaken tests, delete assertions, skip checks, or work around missing
secrets, credentials, permissions, external outages, or infrastructure
failures. PullOps deterministically verifies the resulting diff and will not
commit repairs that delete or skip tests, remove assertions, or alter check
and workflow configuration. If a safe code repair is not possible, return
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
  "failureReason": "Specific reason the CI failure could not be safely fixed.",
  "classifications": [
    {
      "checkId": "check-1",
      "classification": "environment",
      "rationale": "The runner lost network access while installing dependencies."
    }
  ]
}
```
