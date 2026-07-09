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

1. Read the supplied issue body and any parent context. Identify the requested
   behavior, explicit constraints, and acceptance signals before editing.
   Completion criterion: the issue boundary is clear enough to decide whether a
   discovered change is in scope, Adjacent Work, follow-up, or blocked.
2. Use the appropriate discipline:
   - Use `coding-standards` before editing source files, tests, public APIs, or types.
   - Use `tdd` where the issue has a clear behavior seam that can be covered incrementally.
   - Use `diagnosing-bugs` when the issue is bug-shaped and no tight reproduction exists yet.
   Completion criterion: every referenced discipline needed for this issue has
   been applied before the relevant edits.
3. Implement the smallest coherent change that satisfies the issue. Allow only
   Adjacent Work required to complete it correctly. Record unrelated defects,
   broad refactors, and larger design problems as `followUps` instead of
   folding them into the implementation.
   Completion criterion: the working tree contains only issue-focused work or
   necessary Adjacent Work.
4. Run focused verification appropriate for the change. If automated
   verification is unavailable, perform the tightest manual check available and
   say exactly what was checked in `testPlan`.
   Completion criterion: `testPlan` names verification that was actually run,
   or the focused manual check used when automated verification was unavailable.

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
