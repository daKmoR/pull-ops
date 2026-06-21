# PullOps Event Supervision

Use this reference while supervising `prd:auto-complete --events jsonl`.

## Reading Events

Parse stdout as JSONL. Also read the matching run record when available:
`.pullops/runs/<run-id>/events.jsonl` and `result.json`.

Important event fields:

- `event`: phase and progress marker, especially `run.summary`.
- `status`: `accepted`, `blocked`, `failed`, or `refused` on `run.summary`.
- `blockers`: retryable or external blockers.
- `suggestedActions`: commands PullOps believes are safe next steps.
- `localNextSteps` or `nextSteps`: human-readable next actions.
- `children`, `parentPullRequest`, `pullRequest`: PR/issue state to inspect.
- `localRunRecord`: run artifact path for post-failure diagnosis.

If the process exits before a `run.summary`, use stderr, partial events, git
state, and the newest `.pullops/runs/*` record to classify the stop.

## Status Rules

- `accepted`: verify whether any `localNextSteps` are executable by the agent.
  If they are only "review/merge manually", report the human merge boundary.
- `blocked` with retryable suggested command: inspect why it is waiting. Rerun
  automatically after checks, labels, or routed operations are cleared.
- `blocked` due to dependency: run or resume the blocking child when PullOps can
  do so without product judgment; otherwise report the dependency.
- `refused` with `wrong-target`: follow the suggested parent PRD command unless
  the user explicitly wanted the child issue.
- `failed`: diagnose as a bug or environment failure. Prefer fixing PullOps over
  requiring the user to intervene.

## Recovery Map

Known PullOps failure shapes and preferred recovery:

- Stale `pullops:human-required` label after an earlier failed run: inspect the
  PR body, labels, and latest operation. If the current state is no longer human
  required, remove only that stale label and rerun.
- Finalize routes back to review: do not stop at `routedTo`. Continue the routed
  `pr:review`, `pr:address-review`, or `pr:finalize` operation until accepted or
  externally blocked.
- Review/address/finalize loops exceed a hardcoded cycle cap: look for an
  arbitrary attempt limit in PullOps coordination code. Replace it with a
  generous runaway guard that still allows legitimate progress.
- Finalized tree differs after rewriting onto newer `origin/main`: compare the
  reviewed changed paths, not only whole-tree equality. Base-only movement must
  not invalidate a reviewed rewrite.
- Cherry-pick conflict left in progress: inspect `git status`, conflict markers,
  staged files, and the commit being picked. Resolve the conflict, continue or
  abort only with a clear reason, then consider whether PullOps should clean up
  this state itself.
- Waiting for checks: use `gh pr checks` on the referenced PR/head. If checks
  pass, rerun the original PRD command. If checks fail, run the appropriate
  PullOps fix operation or diagnose the failing test.
- Dirty worktree guardrail: separate user changes from PullOps-generated work.
  Do not reset user changes. Commit/stash only when the user asked or the changes
  are known PullOps automation output that must be preserved.

## Command Discipline

When rerunning a PRD, include the same publication intent:

```bash
node ./src/cli/cli.js run prd:auto-complete <issue> --events jsonl --publish pr
```

When an event `suggestedActions[].argv` omits `--events jsonl`, add it back for
PRD auto-complete supervision unless the suggested command is intentionally a
different operation.

Use `PATH="/Users/thomasallmer/.volta/bin:$PATH"` in this repository when the
local shell cannot find the expected Node version.
