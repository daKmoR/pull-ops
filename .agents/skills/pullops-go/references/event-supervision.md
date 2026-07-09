# PullOps Event Supervision

Use this reference while supervising
`spec:auto-complete --runner external --events jsonl`.

## Reading Events

Parse stdout as JSONL. During healthy nested Spec work, parent
`child.heartbeat` events are the default nested-run PullOps Liveness Signal.
Also use the matching `.pullops/runs/<run-id>/events.jsonl` and `result.json`
when available.

Semantic PullOps Progress Events are milestones, phase changes, ticket
completions, blockers, and terminal summary records. Child Heartbeat Events are
live liveness records emitted as parent `child.heartbeat` JSONL events from the
Parent Event Sink. They are distinct from `ticket.progress` semantic milestones;
supervisors must not report liveness as implementation progress.

Human-facing heartbeat display may throttle or coalesce Child Heartbeat Events
without dropping machine-readable `child.heartbeat` JSONL events. Durable ticket
Local Run Records and child `state.json` reads are reserved for stream
interruption, sink loss, lease expiry reconciliation, or postmortem inspection.

Important event fields:

- `event`: phase and progress marker, especially `run.summary`.
- `status`: `accepted`, `blocked`, `failed`, `refused`, or `waiting` on
  `run.summary`. `waiting` appears only when an external runner handoff is
  pending and carries a `runnerJob`.
- `blockers`: retryable or external blockers.
- `suggestedActions`: commands PullOps believes are safe next steps.
- `localNextSteps` or `nextSteps`: human-readable next actions.
- `tickets`, `parentPullRequest`, `pullRequest`: PR/issue state to inspect.
  Ticket and parent entries reference their runner jobs compactly; the
  executable handoff is only the top-level `runnerJob` (also recorded in the
  run's Local Run State).
- `localRunRecord`: run artifact path for post-failure diagnosis.
- `heartbeatAt`, `leaseExpiresAt`, `heartbeatCount`, `heartbeatSummary`:
  liveness fields on `child.heartbeat` events.
- `completedNonHeartbeatStepsSinceHeartbeat`: worker activity since the
  heartbeat, not semantic implementation progress.

If the process exits before a `run.summary`, use stderr, partial events, git
state, and the newest `.pullops/runs/*` record to classify the stop. A truncated
stream is a recovery path where reading durable `state.json` is appropriate.

## Healthy Supervision

Use an observe, reconcile, start next eligible operation, wait loop:

- Report semantic milestones immediately, including ticket starts, completions,
  blockers, review phases, finalization, and terminal summaries.
- Give compact healthy-run updates every 5-10 minutes while work is still
  healthy. Base the update on the latest semantic event plus coalesced Ticket
  Heartbeat Event facts; do not display every heartbeat.
- While the PullOps Lease is active and `child.heartbeat` liveness is flowing,
  wait. Avoid artifact, process, git, CI, or GitHub probing while a run remains
  healthy; do not probe artifacts, processes, git state, CI, GitHub, ticket
  `state.json`, or child Local Run Records merely because semantic events are
  quiet.
- After stream interruption, suspected sink loss, or lease expiry, reconcile
  PullOps Liveness Signals from durable child run state before intervening.
- If a Child Heartbeat Event or durable reconciliation shows liveness advanced,
  continue waiting from the refreshed lease state.
- If liveness did not advance, record a PullOps Stall Classification before
  stopping, retrying, or replacing work.

Do not use logs, git diff, CI, or GitHub state as required liveness signals.
They may help diagnose a failure after reconciliation, but they must not be used
to declare a healthy leased run stuck. Do not perform routine child `state.json`
inspection during healthy work; durable child run-state reads are fallback and
recovery tools.

## Worker Liveness During a Handoff

After the CLI exits at a `waiting` handoff, no parent event stream exists, so
the healthy-run rules above about avoiding durable reads do not apply to the
handed-off run. The hidden worker the manager spawned heartbeats into that run
record's `state.json` (`heartbeatAt`, `heartbeatCount`, `heartbeatSummary`,
`leaseExpiresAt`); watching those fields is the intended liveness channel for
the manager's own worker, alongside waiting for `runner_output.json` to appear.
Report coalesced heartbeat summaries as liveness, not implementation progress,
and reconcile before intervening if the lease expires without a fresh
heartbeat.

## Stall Classification

Before intervention, record the stall facts in the run record when PullOps
provides a mechanism for doing so, or report the missing mechanism as a PullOps
bug. Include phase, reason, last Child Heartbeat Event or durable heartbeat,
lease expiry, child runs, owned worker identity, and recommended action.

Only stop the worker process owned by the current PullOps run. Do not kill unrelated processes,
reset or discard local changes, or start parallel same-branch work before lease reconciliation.

## Status Rules

- `waiting` with a `runnerJob`: this is an executable external runner handoff,
  not a failure or external decision. Execute the handoff per the PullOps Go
  Run rules, then continue the operator loop from the complete output.
- `accepted`: verify whether any `localNextSteps` are executable by the agent.
  If they are only "review/merge manually", report the human merge boundary.
- `blocked` with retryable suggested command: inspect why it is waiting. Rerun
  automatically after checks, labels, or routed operations are cleared.
- `blocked` due to dependency: run or resume the blocking ticket when PullOps can
  do so without product judgment; otherwise report the dependency.
- `refused` with `wrong-target`: follow the suggested parent Spec command unless
  the user explicitly wanted the ticket.
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
  pass, rerun the original Spec command. If checks fail, run the appropriate
  PullOps fix operation or diagnose the failing test.
- Dirty worktree guardrail: separate user changes from PullOps-generated work.
  Do not reset user changes. Commit/stash only when the user asked or the changes
  are known PullOps automation output that must be preserved.

## Command Discipline

Before running any PullOps CLI command from this reference, read and follow
[`docs/agents/pullops-cli.md`](../../../../docs/agents/pullops-cli.md).

After a child complete command reports `accepted` under a Spec run, its output
includes a `suggestedActions[]` entry pointing back at the parent Spec command.
Prefer running that `argv` (wrapped in the standard `npm exec` form) over
reconstructing the command from prose.

When rerunning a Spec without a suggested action, include the same publication
intent:

```bash
npm_config_cache=/tmp/pullops-npm-cache npm exec -- pullops run spec:auto-complete <issue> --runner external --events jsonl --publish pr
```

When an event `suggestedActions[].argv` omits `--runner external` or
`--events jsonl`, add them back for Spec auto-complete supervision unless the
suggested command is intentionally a different operation.

If the local shell cannot find the expected Node version, prepend your Node
version manager's bin directory to `PATH` before running PullOps commands.
