---
name: pullops-issue-implement
description: Implement one PullOps issue and return structured implementation output.
disable-model-invocation: true
---

# PullOps Implement Issue

Implement the supplied Concrete Issue or manually selected Ticket as
written. For a Ticket, use the Parent Issue as context only; the selected
Ticket is the implementation boundary.

## Implement

The how lives in the shared engineering skills; this skill adds only the
PullOps boundary and output contract. Work the issue as `/implement`
describes: use `/tdd` where the issue has a clear behavior seam, run
typechecking and single test files regularly, and a focused verification pass
at the end. Use `/coding-standards` before editing source, tests, public APIs,
or types, and `/diagnosing-bugs` when the issue is bug-shaped and no tight
reproduction exists yet.

Scope: implement the smallest coherent change that satisfies the issue as
written, plus only the Adjacent Work required to complete it correctly. Record
unrelated defects, broad refactors, and larger design problems as `followUps`.
When the issue boundary is not clear enough to decide whether a discovered
change is in scope, that is a `blocked` reason, not a license to guess.

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

Heartbeats must originate from this implementation agent process, not from the parent PullOps CLI.

PullOps boundary: use referenced skills for their discipline only. Do not ask the
user, emit non-JSON, commit, push, change labels, create PRs, or leave this
operation's issue-focused scope. PullOps handles committing, pushing, labels,
and PR creation after validating your output.

Completion criteria:

- The issue is implemented as written, or the blocked JSON names the specific
  reason it cannot be implemented.
- The working tree contains only issue-focused work or adjacent work needed to complete the issue correctly.
- `changes` names concrete code, test, or documentation edits.
- `testPlan` names verification that was actually run, or the focused manual check used when automated verification was not available.

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
