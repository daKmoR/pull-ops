---
name: pullops-resolve-conflicts
description: Resolve the current PullOps rebase conflict pass.
disable-model-invocation: true
---

# PullOps Resolve Conflicts

Resolve the current conflicted rebase pass for the PullOps-managed PR. PullOps
starts the rebase, supplies the conflict context, validates this output,
continues the rebase, and may invoke another pass if later commits conflict.

Use the source-and-intent discipline from `resolving-merge-conflicts`, but stop
before its final staging and rebase-continuation step. PullOps owns staging,
`git rebase --continue`, pushing, labels, PR body updates, and GitHub comments.

## Resolve

1. Inventory the supplied conflict context: linked issue or PRD, PR body, branch
   name, base branch, conflict pass, conflicted file list, working tree content,
   and stage 1/2/3 contents. Completion criterion: every supplied conflicted
   path has been copied into a local resolved-file ledger exactly as written.
2. Find the intent for each side of each conflict. Use the conflict context,
   issue or PRD, PR body, file history, and the stage contents to identify what
   base, ours, and theirs were trying to preserve. Completion criterion: every
   conflicted file has enough intent to resolve safely, or the result is
   `blocked` with the specific missing context or irreconcilable trade-off.
3. Edit the real conflicted files in this checkout. Preserve both intents where
   possible. When they are incompatible, choose the result that matches the PR
   and rebase goal, and record the trade-off in `changes` or `followUps`. Do
   not invent new behavior. Completion criterion: every supplied conflicted
   file has working-tree content that contains no Git conflict markers.
4. Run the coverage check before responding. Completion criterion:
   `resolvedFiles` exactly equals the supplied conflicted file list; no path is
   omitted, duplicated, renamed, or invented.
5. Run focused verification when the repository state allows it. If automated
   checks cannot run during the conflicted rebase, perform the tightest manual
   check available and say exactly what was checked in `testPlan`. Completion
   criterion: `testPlan` names verification that actually ran, or the concrete
   reason automated verification could not run.

If any completion criterion cannot be met safely, return the blocked JSON
shape.

## Output Rules

- `resolvedFiles` must exactly equal the supplied conflicted file list.
- `changes` must name concrete conflict-resolution edits or trade-offs.
- `testPlan` must name commands or manual checks actually performed.
- Put non-blocking cleanup outside this conflict pass in `followUps`.
- Do not add unsupported top-level fields.

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

Heartbeats must originate from this conflict-resolution agent process, not from the parent PullOps CLI.

Do not stage files, create commits, continue or abort the rebase, push, edit
labels, update the PR body, or post GitHub comments. PullOps will validate your
output, continue the rebase, repeat conflict passes if needed, and push after
the conflicts are resolved.

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
