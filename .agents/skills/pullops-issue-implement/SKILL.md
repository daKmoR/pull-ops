---
name: pullops-issue-implement
description: Implement one PullOps Concrete Issue or manually selected Child Issue and report structured implementation output for the CLI.
disable-model-invocation: true
---

# PullOps Implement Issue

Implement the supplied issue as written.

- Use /coding-standards before editing source files, tests, public APIs, or types.
- Use /tdd where the issue has a clear behavior seam that can be covered incrementally.
- Use /diagnosing-bugs when the issue is bug-shaped and no tight reproduction exists yet.
- Keep changes focused, allowing only adjacent work needed to complete the issue correctly.
- Run focused verification that is appropriate for the change.

## Liveness and command execution

Use PullOps as the command gate.

Do not run shell commands directly. For every shell command, use:

```bash
npm exec pullops -- step "<brief current focus>" -- <command>
```

For commands that may run longer than 4 minutes, use:

```bash
npm exec pullops -- step --long "<brief current focus>" -- <command>
```

`pullops step` automatically emits heartbeats when needed. Do not manually count time or tool calls for shell commands.

If you are about to make several non-shell tool calls, send a manual heartbeat first:

```bash
npm exec pullops -- heartbeat --summary "<brief current focus>"
```

Heartbeats must originate from this implementation agent process, not from the parent PullOps CLI.

PullOps boundary: use referenced skills for their discipline only. Do not ask the
user, emit non-JSON, commit, push, change labels, create PRs, or leave this
operation's issue-focused scope. PullOps handles committing, pushing, labels,
and PR creation after validating your output.

Completion criteria:

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
