# PullOps Event Supervision

Use this reference while supervising `prd:auto-complete --events jsonl`.

## Reading Events

Parse stdout as JSONL. Also read the matching run record when available:
`.pullops/runs/<run-id>/events.jsonl`, `state.json`, and `result.json`.

Use JSONL PullOps Progress Events plus PullOps Run State during healthy
execution. Progress Events are semantic progress, milestone, and terminal
summary records; do not expect or display every PullOps Heartbeat as a progress
event. Run State is the machine-only supervision surface for status, phase,
heartbeat, lease, last event, and child run facts.

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

## Healthy Supervision

Use an observe, reconcile, start next eligible operation, wait loop:

- Report semantic milestones immediately, including child starts, completions,
  blockers, review phases, finalization, and terminal summaries.
- Give compact healthy-run updates every 5-10 minutes while work is still
  healthy. Base the update on the latest semantic event plus Run State; do not
  display every heartbeat.
- While the PullOps Lease is active, wait. Do not probe artifacts, processes,
  git state, CI, or GitHub merely because the event stream is quiet.
- After lease expiry, reconcile v1 PullOps Liveness Signals before
  intervening. Reliable v1 liveness is an advanced heartbeat or a changed child
  run set.
- If liveness advanced, continue waiting from the refreshed state.
- If liveness did not advance, record a PullOps Stall Classification before
  stopping, retrying, or replacing work.

Logs, git diff, GitHub state, and CI state may help diagnose a failure after
reconciliation, but they are not required v1 liveness signals and must not be
used to declare a healthy leased run stuck.

## Stall Classification

Before intervention, record the stall facts in the run record when PullOps
provides a mechanism for doing so, or report the missing mechanism as a PullOps
bug. Include phase, reason, last heartbeat, lease expiry, child runs, owned
worker identity, and recommended action.

Only stop the worker process owned by the current PullOps run. Do not kill
unrelated processes, reset or discard local changes, or start parallel work on
the same branch before lease reconciliation.

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
