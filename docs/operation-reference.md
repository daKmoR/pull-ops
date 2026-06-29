# PullOps Operation Reference

This is the compact source of truth for what each PullOps command and label means.

## Most Used Operation Requests

Human-Facing Commands and Operation Labels are two request surfaces for the same
PullOps Operation. Commands run locally by default. Labels dispatch workflow
execution. Commands apply labels only with `--backend github-actions`.
For `issue:implement`, the default local path runs implementation, automated
review, and PR finalization; `--until operation` is the explicit
implementation-only escape hatch.
`Equivalent label` is filled only when the command is intended to produce the
same GitHub result as applying that label; blank means the command is a local
dry-run or another non-equivalent variant of the operation.
Equivalence is about the resulting repository state and workflow intent; local
actor, token, and audit metadata may differ from GitHub Actions execution.

| Operation request (`pullops run ...`)           | Equivalent label            | Target         | Flow (implement -> review -> finalize)                                     | Meaning                                                   | Approval needed              |
| ----------------------------------------------- | --------------------------- | -------------- | -------------------------------------------------------------------------- | --------------------------------------------------------- | ---------------------------- |
| `issue:implement <issue> --publish pr`          | `pullops:issue:implement`   | Concrete Issue | implement -> review -> finalize -> create/update PR                        | Implement an issue for PR review after local finalization | Issue PR approval            |
| `issue:implement <issue>`                       |                             | Concrete Issue | implement -> review -> finalize                                            | Implement an issue for local review and finalization      | None                         |
| `prd:auto-advance <parent-issue> --publish pr`  | `pullops:prd:auto-advance`  | PRD Issue      | for every currently unblocked Child Issues + create PR                     | Implement current unblocked frontier and publish PRs      | Every Child Issue PR         |
| `prd:auto-advance <parent-issue>`               |                             | PRD Issue      | for every currently unblocked Child Issues                                 | Implement current unblocked frontier locally              | None                         |
| `prd:auto-complete <parent-issue> --publish pr` | `pullops:prd:auto-complete` | PRD Issue      | child PR -> review -> finalize -> integrate -> umbrella review -> finalize | Complete the PRD branch through traceable Child Issue PRs | Final Umbrella PR merge only |
| `prd:auto-complete <parent-issue>`              |                             | PRD Issue      | for every Child Issue                                                      | Complete the PRD branch locally                           | None                         |

`prd:auto-advance` drains only the currently unblocked native Child Issue frontier.
Human merges close those Child Issues and can unlock the next frontier for a later execution.
`prd:auto-complete` keeps advancing through those frontiers itself until the PRD
branch is complete or blocked.
Local dry-run `prd:auto-complete` simulates those later frontiers without GitHub
mutation: each locally completed or locally integrated Child Issue virtually
satisfies downstream `Blocked by` dependencies in the same run, and the Local
Run Record captures child branch evidence, dependency decisions, remaining
blocked children, and next steps. Existing active Child Issue PRs remain approval
boundaries; local dry-run does not duplicate their work or treat them as complete
until their managed PR state is finalized enough to integrate locally.
Published `prd:auto-complete --publish pr` performs the same frontier progression
with GitHub mutations. It creates or reuses one Child Issue PR per runnable Child
Issue, drives that PR through review/finalization, integrates the finalized head
into the Umbrella Branch, closes the Child Issue, and repeats until no reachable
Child Issue remains. When all reachable Child Issues are integrated, it runs
automated review and PR Finalize on the Umbrella PR, then stops before the human
default-branch merge.

## Other Human Commands

| Operation request (`pullops run ...`)                | Equivalent label | Target                                    | Flow                                                      | Meaning                                                                                            |
| ---------------------------------------------------- | ---------------- | ----------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `issue:implement <issue> --until operation`          |                  | Concrete Issue                            | implement                                                 | Fast implementation-only local run.                                                                |
| `issue:implement <issue> --until finalized`          |                  | Concrete Issue                            | implement -> review -> finalize                           | Explicit finalized local run.                                                                      |
| `prd:auto-advance <parent-issue> --until operation`  |                  | PRD Issue                                 | prepare -> start currently unblocked Child Issues         | Fast PRD coordination run without local follow-up loops.                                           |
| `prd:auto-complete <parent-issue> --until operation` |                  | PRD Issue                                 | prepare -> inspect/start currently unblocked Child Issues | Fast PRD coordination run without local completion loops.                                          |
| `pr:review <pull-request>`                           |                  | PullOps-Managed PR                        | review                                                    | Run automated PR review.                                                                           |
| `pr:address-review <pull-request>`                   |                  | PullOps-Managed PR                        | address feedback                                          | Address Actionable PR Feedback.                                                                    |
| `pr:fix-ci <pull-request>`                           |                  | PullOps-Managed PR                        | classify CI -> fix CI                                     | Fix actionable CI failures. Local dry-run is not implemented yet.                                  |
| `pr:update-branch <pull-request>`                    |                  | Same-Repository PR                        | update branch                                             | Bring a PR branch up to date without AI conflict resolution. Local dry-run is not implemented yet. |
| `pr:resolve-conflicts <pull-request>`                |                  | Pull request with branch update conflicts | resolve conflicts                                         | Resolve real update conflicts with the runner. Local dry-run is not implemented yet.               |
| `pr:finalize <pull-request>`                         |                  | PullOps-Managed PR                        | finalize                                                  | Prepare final history and PR state for human merge.                                                |

## Exact Label Dispatch Commands

These commands are the human-facing way to apply the matching Operation Label
through GitHub Actions.

| Operation request (`pullops run ...`)                          | Equivalent label               | Target                                    | Flow                                                  | Meaning                                   |
| -------------------------------------------------------------- | ------------------------------ | ----------------------------------------- | ----------------------------------------------------- | ----------------------------------------- |
| `prd:prepare <parent-issue> --backend github-actions`          | `pullops:prd:prepare`          | PRD Issue                                 | prepare Umbrella Branch -> create/update Umbrella PR  | Dispatch PRD preparation.                 |
| `issue:implement <issue> --backend github-actions`             | `pullops:issue:implement`      | Concrete Issue                            | implement -> review -> finalize -> create/update PR   | Dispatch issue implementation.            |
| `prd:auto-advance <parent-issue> --backend github-actions`     | `pullops:prd:auto-advance`     | PRD Issue                                 | for every currently unblocked Child Issue + create PR | Dispatch PRD auto-advance.                |
| `prd:auto-complete <parent-issue> --backend github-actions`    | `pullops:prd:auto-complete`    | PRD Issue                                 | for every Child Issue + create PR + integrate         | Dispatch PRD auto-complete.               |
| `pr:review <pull-request> --backend github-actions`            | `pullops:pr:review`            | PullOps-Managed PR                        | review                                                | Dispatch automated PR review.             |
| `pr:address-review <pull-request> --backend github-actions`    | `pullops:pr:address-review`    | PullOps-Managed PR                        | address feedback                                      | Dispatch Actionable PR Feedback response. |
| `pr:fix-ci <pull-request> --backend github-actions`            | `pullops:pr:fix-ci`            | PullOps-Managed PR                        | classify CI -> fix CI                                 | Dispatch CI repair.                       |
| `pr:update-branch <pull-request> --backend github-actions`     | `pullops:pr:update-branch`     | Same-Repository PR                        | update branch                                         | Dispatch non-AI branch update.            |
| `pr:resolve-conflicts <pull-request> --backend github-actions` | `pullops:pr:resolve-conflicts` | Pull request with branch update conflicts | resolve conflicts                                     | Dispatch AI conflict resolution.          |
| `pr:finalize <pull-request> --backend github-actions`          | `pullops:pr:finalize`          | PullOps-Managed PR                        | finalize                                              | Dispatch PR Finalize.                     |

## Label Lifecycle

All Operation Labels are requests that PullOps removes when the request is
fulfilled, except durable PRD automation labels:

- `pullops:prd:auto-advance`
- `pullops:prd:auto-complete`

Durable PRD automation labels stay on the PRD Issue because they represent the
active PRD automation mode and let later child merges resume coordination.

## Repository Commands

| Command                       | Meaning                                                   |
| ----------------------------- | --------------------------------------------------------- |
| `pullops setup github-labels` | Reconciles PullOps operation and status labels in GitHub. |

## Workflow-Facing Commands

These commands are generated workflow plumbing. Maintainers usually should not
type them directly unless they are debugging a workflow.

| Command                                          | Target option | Meaning                                                                                                         |
| ------------------------------------------------ | ------------- | --------------------------------------------------------------------------------------------------------------- |
| `pullops run prd-prepare --issue <number>`       | `--issue`     | Create or refresh the Umbrella Branch and draft Umbrella PR for a PRD Issue.                                    |
| `pullops run issue-implement --issue <number>`   | `--issue`     | Implement one Concrete Issue and open or update its PullOps-managed PR.                                         |
| `pullops run prd-auto-advance --issue <number>`  | `--issue`     | Coordinate a PRD Issue by preparing it and starting currently unblocked Child Issues.                           |
| `pullops run prd-auto-complete --issue <number>` | `--issue`     | Coordinate hands-off PRD branch completion while leaving the default-branch merge human-controlled.             |
| `pullops run pr-review --pr <number>`            | `--pr`        | Run automated review for a PullOps-managed PR.                                                                  |
| `pullops run pr-address-review --pr <number>`    | `--pr`        | Address Actionable PR Feedback on a PullOps-managed PR.                                                         |
| `pullops run pr-fix-ci --pr <number>`            | `--pr`        | Classify and fix actionable CI failures on a PullOps-managed PR.                                                |
| `pullops run pr-update-branch --pr <number>`     | `--pr`        | Update a Same-Repository PR branch without AI conflict resolution.                                              |
| `pullops run pr-resolve-conflicts --pr <number>` | `--pr`        | Use the runner to resolve real branch update conflicts.                                                         |
| `pullops run pr-finalize --pr <number>`          | `--pr`        | Shape a PullOps-managed PR into its final human-merge form.                                                     |
| `pullops run pr-close-child-issue --pr <number>` | `--pr`        | Deterministically close a Child Issue after its same-repository Child Issue PR merges into the Umbrella Branch. |

Codex Action workflow runs split Codex-backed operations into
`--phase prepare` and `--phase finalize` commands. Those phase commands are
workflow lifecycle plumbing, not maintainer-facing controls.

## Status Label

PullOps avoids using labels for ordinary progress. The only Status Label is for
exceptional states that need attention.

| Label                        | Meaning                                                                   | Installed by `pullops setup github-labels`? |
| ---------------------------- | ------------------------------------------------------------------------- | ------------------------------------------- |
| `pullops:human-required`     | PullOps automation needs maintainer attention.                            | Yes                                         |
| `pullops:status:in-progress` | PullOps automation is actively working on the target.                     | Yes                                         |
| `pullops:status:blocked`     | PullOps automation is blocked and needs maintainer attention.             | Yes                                         |
| `pullops:status:prepared`    | PullOps automation prepared the target and is waiting for the next step.  | Yes                                         |
| `pullops:status:done`        | PullOps automation completed the target and is waiting for the next step. | Yes                                         |
| `pullops:status:failed`      | PullOps automation failed and needs maintainer attention.                 | Yes                                         |
