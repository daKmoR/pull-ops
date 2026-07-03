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
   - Parent PRD: run `npm_config_cache=/tmp/pullops-npm-cache npm exec -- pullops run prd:auto-complete <issue> --events jsonl --publish pr`.
   - Concrete issue or manually selected child issue: run `npm_config_cache=/tmp/pullops-npm-cache npm exec -- pullops run issue:implement <issue> --publish pr`.
   - Explicit PullOps PR operation: run the matching `pr:*` command the user named.
   Completion criterion: exactly one target and one command are selected, or
   there is no target.
2. If no target was supplied, discover open PRDs and implementable issues using
   GitHub issue metadata, labels, and PullOps conventions. Start with
   `gh issue list --repo daKmoR/pull-ops --state open --json number,title,labels,url,updatedAt`
   and inspect bodies only for plausible candidates. Present a short numbered
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
2. Run the selected command locally. Add `--events jsonl` for
   `prd:auto-complete`; it is currently supported only for that operation. For
   other operations, supervise stdout and run records.
3. If a local command exits zero with `status: "waiting"` and a `runnerJob`,
   treat it as an executable handoff. If live stdout was interrupted, recover
   the same handoff from the newest matching Local Run State whose status is
   `waiting` and whose `runnerJob` is present. This boundary is expected work,
   not a failure, refusal, or external decision.
4. Execute one external runner handoff at a time:
   - Spawn one hidden worker at a time through the Codex host using
     `runnerJob.workerPrompt` in `runnerJob.cwd`. Do not invoke a nested
     `codex exec` from the PullOps CLI.
   - The worker writes only `runner_output.json` through the path named by
     `runnerJob.outputFile`. The manager owns `runner_result.json`.
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
5. When supervising `prd:auto-complete --events jsonl`, read
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
   checks, and focused source/tests.
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
