---
name: pullops-go
description: Drive a PullOps PRD, issue, or PR operation to the next real finish line.
disable-model-invocation: true
---

# PullOps Go

PullOps go is an operator loop: choose the target, run the repo-local PullOps
command, repair PullOps when automation breaks, and stop only at a real finish
line or an external decision.

Before running any PullOps CLI command, read and follow
[`docs/agents/pullops-cli.md`](../../../docs/agents/pullops-cli.md).

## Choose

1. If the user named a PRD, issue, PR, or command, classify it before asking
   anything:
   - Parent PRD: run `npm_config_cache=/tmp/pullops-npm-cache npm exec -- pullops run prd:auto-complete <issue> --runner external --events jsonl --publish pr`.
   - Concrete issue or manually selected child issue: run `npm_config_cache=/tmp/pullops-npm-cache npm exec -- pullops run issue:implement <issue> --publish pr`.
   - Explicit PullOps PR operation: run the matching `pr:*` command the user named.
   Completion criterion: exactly one target and one command are selected, or
   there is no target.
2. If no target was supplied, discover open PRDs and implementable issues using
   GitHub issue metadata, labels, and PullOps conventions. Start with
   `gh issue list --state open --json number,title,labels,url,updatedAt` in the
   Target Repository and inspect bodies only for plausible candidates. Present a short numbered
   list grouped as PRDs first, then issues. Include enough context to choose:
   number, title, current PullOps label/status, blocked/waiting signal, and
   likely command. Completion criterion: the user can pick one item without
   another lookup.
3. If there are no PRDs or implementable issues, ask what topic the user wants
   to turn into a PRD or issue. When they answer, ask them to invoke
   `grill-with-docs` with that topic. Completion criterion: the user has a
   concrete next prompt for the planning session, not idle waiting.

## Run

1. Before running the CLI, record the current branch and `git status --short`.
   Avoid overwriting unrelated user changes.
2. Run the selected command locally. Add `--runner external --events jsonl` for
   `prd:auto-complete`; events are currently supported only for that operation.
   For other operations, supervise stdout and run records.
3. If a local command exits zero with `status: "waiting"` and a `runnerJob`,
   treat it as an executable handoff. If live stdout was interrupted, recover
   the same handoff from the newest matching Local Run State whose status is
   `waiting` and whose `runnerJob` is present. This boundary is expected work,
   not a failure, refusal, or external decision.
4. Execute one external runner handoff at a time (this limit applies to runner
   handoffs only; read-only helper sub-agents for diagnosis or discovery may run
   alongside while the supervision loop stays with the operator):
   - Spawn one hidden worker at a time through the session's agent host using
     `runnerJob.workerPrompt` in `runnerJob.cwd`: a Codex hidden worker on the
     Codex host, a background sub-agent on Claude Code, or the equivalent
     host-native worker elsewhere. Do not invoke a nested `codex exec` from the
     PullOps CLI. If the host denies spawning an external agent process, fall
     back to the host-native sub-agent with the same worker prompt and
     artifact contract; `runnerJob.model` is advisory and binds only hosts
     that can select it.
   - When the job carries `heartbeatEnvironment`, provide it to the worker
     (export it for a worker process; the same entries are embedded in the
     worker prompt for prompt-driven workers).
   - The worker writes only `runner_output.json` through the path named by
     `runnerJob.outputFile`. The manager owns `runner_result.json`.
   - While the hidden worker runs, its PullOps Heartbeats land in the run
     record's `state.json` (`heartbeatAt`, `heartbeatCount`,
     `heartbeatSummary`, `leaseExpiresAt`). Watch those fields for worker
     liveness during the handoff; if the lease expires without a fresh
     heartbeat, reconcile before intervening.
   - Record success only when the hidden worker completed and
     `runnerJob.outputFile` exists with non-empty contents. Otherwise record
     `failed`, `cancelled`, or `skipped` according to the worker outcome.
   - Write `runner_result.json` by running the matching
     `runnerJob.completionCommands[status]` command with its explicit `argv`
     and `env`.
   - After `runner_result.json` is written, run `runnerJob.completeCommand`
     with its explicit `argv` and `env`, then continue the operator loop from
     that complete output.
   PullOps Heartbeats remain worker-owned liveness; the manager must not fake worker heartbeats.
5. When supervising `prd:auto-complete --runner external --events jsonl`, read
   [`references/event-supervision.md`](references/event-supervision.md) before
   acting on events. Apply its event, liveness, and recovery rules. Completion
   criterion: every `run.summary` status, blocker, suggested action, and local
   next step has been completed, rerun, or reported as an external wait.
6. Keep the operator loop moving until it reaches one finish line:

- PRD accepted with a finalized or waiting umbrella/child PR state and clear
  local next steps.
- Issue implementation published or finalized with a created/updated PR.
- PR operation accepted and no immediate routed PullOps operation remains.
- A real blocker remains that the agent cannot clear without external approval.

Completion criterion: one finish line is reached and no executable routed
operation or suggested action remains.

## Repair

Treat failures, refusals, loops, and unreasonable human-required stops as
PullOps bugs until diagnosis proves an external decision is required.

1. Diagnose from the event summary, run record, git state, PR body, labels,
   checks, and focused source/tests. Parallelizable read-only diagnosis or
   discovery may be delegated to sub-agents while the operator keeps the
   supervision loop; repair edits stay with the operator.
2. If the failure is in PullOps, use `diagnosing-bugs` for reproduction and
   root cause. Use `coding-standards` before editing source, tests, public APIs,
   or types.
3. Fix PullOps directly on the current repo branch, add a focused regression
   test, and run focused verification. Push the fix only when the surrounding
   workflow already requires remote state.
4. Rerun the original PullOps command with the same publication intent.

Do not ask the user to manually run cleanup that can be performed safely by the
agent. Ask only before destructive git operations, changing product scope, or
when GitHub requires a human-only action such as merging a finalized umbrella
PR.

Completion criterion: the original target finishes, reruns to a legitimate
waiting boundary, or is blocked by a specific external decision.

## Report

Keep the final response operational:

- State the target, final status, PR/issue URL, branch/head SHA when relevant,
  and remaining human step if any.
- Name PullOps fixes made along the way and the tests that passed.
- Mention any cleanup deliberately left alone because it belonged to the user.
- Restore the branch recorded at Run step 1 when the worktree is clean and no
  remaining human step needs the current checkout; otherwise say which branch
  the checkout was left on and why.
