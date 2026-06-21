---
name: pullops-go
description: PullOps go drives PullOps PRDs or issues to the next real finish line. Use when the user says PullOps go, asks to start or resume PullOps work, wants a list of implementable PRDs/issues, wants Codex to run PullOps CLI commands, or wants automation errors diagnosed and fixed with minimal human intervention.
disable-model-invocation: true
---

# PullOps Go

PullOps go is an operator loop around the PullOps CLI. Keep the work moving,
repair PullOps itself when automation breaks, and ask the user only when the
next action needs product judgment or external human approval.

## Triage

1. If the user named a PRD, issue, PR, or command, classify it before asking
   anything:
   - Parent PRD: run `node ./src/cli/cli.js run prd:auto-complete <issue> --events jsonl --publish pr`.
   - Concrete issue or manually selected child issue: run `node ./src/cli/cli.js run issue:implement <issue> --publish pr`.
   - Explicit PullOps PR operation: run the matching `pr:*` command the user named.
   Completion criterion: one target and one command are selected, or there is no
   target.
2. If no target was supplied, discover open PRDs and implementable issues using
   GitHub issue metadata, labels, and PullOps conventions. Start with
   `gh issue list --repo daKmoR/pull-ops --state open --json number,title,labels,url,updatedAt`
   and inspect bodies only for plausible candidates. Present a short numbered
   list grouped as PRDs first, then issues. Include enough context to choose:
   number, title, current PullOps label/status, blocked/waiting signal, and
   likely command. Completion criterion: the user can pick one item without
   another lookup.
3. If there are no PRDs or implementable issues, ask what topic the user wants
   to turn into a PRD or issue. When they answer, start `/grill-with-docs`.
   Completion criterion: the next step is a grill-with-docs session, not idle
   waiting.

## Run

Before running the CLI, record the current branch and `git status --short`.
Avoid overwriting unrelated user changes.

Run the selected command locally. Prefer `--events jsonl` for
`prd:auto-complete`; it is currently supported only for that operation. For
other operations, rely on the command output and run records.

Monitor the run until it reaches one of these finish lines:

- PRD accepted with a finalized or waiting umbrella/child PR state and clear
  local next steps.
- Issue implementation published or finalized with a created/updated PR.
- PR operation accepted and no immediate routed PullOps operation remains.
- A real blocker remains that the agent cannot clear without external approval.

When supervising a PRD event stream, read
[`references/event-supervision.md`](references/event-supervision.md) and apply
its event and recovery rules. Completion criterion: every summary status,
blocker, suggested action, and local next step has either been completed,
rerun, or reported as an external wait.

## Repair

Treat failed or silly human-required stops as PullOps bugs until proven
otherwise. Diagnose from the event summary, run record, git state, PR body,
labels, checks, and focused source/tests.

When the failure is in PullOps itself:

- Use `/diagnosing-bugs` for the reproduction and root cause.
- Use `/coding-standards` before editing source, tests, public APIs, or types.
- Fix PullOps directly on the current repo branch, add a focused regression
  test, run focused verification, and push the fix if the surrounding workflow
  already requires remote state.
- Rerun the original PullOps command after the fix.

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
