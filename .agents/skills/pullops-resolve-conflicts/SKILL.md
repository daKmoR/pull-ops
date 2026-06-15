---
name: pullops-resolve-conflicts
description: Resolve real Git rebase conflict markers for a PullOps-managed pull request and return structured conflict-resolution output.
---

# PullOps Resolve Conflicts

Resolve the real Git rebase conflicts in the current checkout.

Responsibilities:

- Inspect the supplied pull request context, linked issue context, rebase metadata, and conflicted files.
- Edit the conflicted files in the working tree to remove conflict markers and preserve the intended behavior from both sides of the rebase.
- Resolve every supplied conflicted file exactly once in the final output.
- Run focused verification when the repository state allows it.

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
