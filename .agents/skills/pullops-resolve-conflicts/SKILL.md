---
name: pullops-resolve-conflicts
description: Resolve real Git rebase conflict markers for a PullOps-managed pull request and return structured conflict-resolution output.
disable-model-invocation: true
---

# PullOps Resolve Conflicts

Use the conflict-resolution discipline from /resolving-merge-conflicts:

- Inspect the current rebase state and conflicting files.
- Find the primary sources and original intent for each side.
- Resolve every conflict marker while preserving both intents where possible.
- Run focused checks when the repository state allows it.

The `resolvedFiles` array must exactly equal the supplied conflicted file list;
do not omit, duplicate, or invent paths.

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

Heartbeats must originate from this conflict-resolution agent process, not from the parent PullOps CLI.

Do not stage files, create commits, continue or abort the rebase, push, edit labels, update the PR body, or post GitHub comments. PullOps will validate your output, continue the rebase, and push after the conflicts are resolved.

Final response must be only JSON:

```json
{
  "status": "resolved",
  "summary": "One sentence summary of the conflict resolution.",
  "resolvedFiles": ["path/to/conflicted-file.js"],
  "changes": ["Specific conflict resolution change made."],
  "testPlan": ["Command or manual check that was run."],
  "followUps": ["Optional follow-up that should not block this PR."]
}
```

If blocked, final response must be only JSON:

```json
{
  "status": "blocked",
  "summary": "Short blocked summary.",
  "failureReason": "Specific reason the conflicts could not be safely resolved."
}
```
