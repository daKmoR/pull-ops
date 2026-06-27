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

Liveness: when `PULLOPS_RUN_STATE_PATH` and `PULLOPS_HEARTBEAT_TOKEN` are
present, run `npm exec pullops -- heartbeat --summary "<brief current focus>"`
as a tool call about every `PULLOPS_HEARTBEAT_INTERVAL_MS` while work stays
active. Heartbeats must come from this conflict-resolution agent, not from the
parent PullOps CLI.

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
