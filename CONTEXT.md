# PullOps

An npm CLI package for installing AI-native GitHub pull request workflows into a repository.

## Language

**Target Repository**:
The repository where PullOps installs workflows, skills, and configuration.
_Avoid_: Consumer repo, project

**Workflow Kit**:
The repo-local set of generated GitHub Actions workflows, agent skills, and PullOps configuration committed into a Target Repository.
_Avoid_: Scaffold, template

**PullOps Skill**:
A repo-local agent skill installed by PullOps to describe one PullOps Operation.
_Avoid_: Agent script, prompt file

**Install Manifest**:
The PullOps-owned record of generated Workflow Kit files and their installed content hashes.
_Avoid_: Lockfile, generated file list

**PullOps Config**:
The Target Repository-owned settings that control how its Workflow Kit behaves.
_Avoid_: Init options, settings file

**PullOps Init**:
The CLI flow that installs or reconciles the Workflow Kit in a Target Repository.
_Avoid_: Setup, bootstrap

**Workflow-Facing Command**:
A PullOps CLI command intended to be called by generated GitHub Actions workflows.
_Avoid_: Internal command, subcommand

**Human-Facing Command**:
A PullOps CLI command intended to be typed directly by a maintainer to run an Operation Label Reference against a target with an Execution Backend and Publication Mode.
_Avoid_: Workflow-facing command, lifecycle command

**Operation Label Reference**:
The command-line spelling of an Operation Label, using only the short `target-kind:operation` form such as `issue:implement` or `prd:auto-advance`.
_Avoid_: Operation name, full label

**Operation Module**:
The package-owned implementation directory for one PullOps Operation, containing its orchestration code, prompts, extraction instructions, and Operation Output schema.
_Avoid_: Workflow script, runner file

**Operation Catalog**:
The PullOps-owned source of truth for the fixed PullOps Operation set and their canonical operation facts, keeping Operation Names, Operation Labels, target kinds, default operation settings, and workflow-facing identity aligned.
_Avoid_: Plugin registry, workflow generator, operation list

**Local PullOps Dependency**:
The Target Repository's package-managed dependency on `@pull-ops/cli`, used by workflows instead of a global install.
_Avoid_: Global CLI, latest CLI

**Package Manager Command**:
The configured command a Workflow Kit uses to install dependencies or execute the Local PullOps Dependency.
_Avoid_: Install command, npm command

**Runner Logic**:
The maintained npm-package logic invoked by generated workflows to execute a PullOps operation.
_Avoid_: Workflow script, action code

**Runner Command**:
The Target Repository configuration that tells PullOps how to invoke the AI coding agent for a PullOps Operation.
_Avoid_: Provider config, model command

**Runner Adapter**:
The PullOps-owned execution path for running an AI coding agent. `codex-cli` runs the configured Runner Command from the PullOps CLI, while `codex-action` splits execution across prepare, GitHub Action, and finalize workflow steps.
_Avoid_: Phase, task script, provider

**Execution Backend**:
The place where a PullOps Operation is executed, such as the active local checkout or GitHub Actions.
_Avoid_: Runner adapter, provider

**Publication Mode**:
The intended visibility and persistence of a PullOps Operation result, such as opening a pull request or leaving local changes for review.
_Avoid_: Output, execution backend

**Run Goal**:
How far a PullOps Execution Backend should continue through PullOps follow-up operations for a target.
_Avoid_: Publication mode, operation label

**Local Run Record**:
A visible, gitignored `.pullops/runs/<timestamp>-<operation-label-reference>-<target-number>/` directory where local execution records artifacts from one PullOps run.
_Avoid_: Hidden cache, audit store

**Operation Run Goal**:
The Run Goal where PullOps runs exactly the requested Operation Label Reference and then stops.
_Avoid_: One-shot mode

**Finalized Run Goal**:
The Run Goal where PullOps follows local PullOps follow-up operations until the pull request is finalized or blocked.
_Avoid_: Full run, final publish

**GitHub State Synchronization**:
A deterministic PullOps workflow that reconciles GitHub issue or pull request state without invoking a Runner Adapter.
_Avoid_: AI operation, runner task

**Model Tier**:
A named runner capability tier, such as high, mid, or low, that operations select instead of naming concrete models directly.
_Avoid_: Model override, model preset

**PullOps Operation**:
A label-requested unit of issue or pull request work, such as preparing a PRD Issue, implementing a Concrete Issue, reviewing a PR, updating a branch, resolving conflicts, or finalizing a PR before merge.
_Avoid_: Job, workflow, task

**Operation Name**:
The canonical target-prefixed identifier for a PullOps Operation, using the same target kind and action as its Operation Label without the `pullops:` prefix, such as `prd-prepare`, `issue-implement`, or `pr-review`.
_Avoid_: Legacy object/action names like `prd-prepare`, `issue-implement`, `pr-review`

**Operation Label**:
A repository label that requests one PullOps Operation on the issue or pull request it is applied to. Operation Labels use the `pullops:<target-kind>:<operation>` grammar, where the target kind identifies PRD Issue, Concrete Issue, or pull request operations.
_Avoid_: Trigger label, command label, flat label

**Status Label**:
A repository label that records that a PullOps target needs maintainer attention, not ordinary workflow progress. PullOps uses status labels only for exceptional human-required states rather than in-progress, prepared, or done workflow states.
_Avoid_: Progress label, completion label, operation label

**Human-Required Label**:
The PullOps Status Label applied when automation cannot safely continue without maintainer action. Normal dependency waits, prepared PRDs, completed issues, merged pull requests, and ready-for-merge pull requests do not use this label.
_Avoid_: Blocked-by dependency, failed state label, done label

**Parent Issue**:
An issue that represents a larger product requirement or PRD and owns implementation work through Child Issues.
_Avoid_: Epic, project

**PRD Issue**:
A Parent Issue handled through the `prd` Operation Label target kind. It represents a PRD-shaped work item, not a separate GitHub issue type.
_Avoid_: Epic, parent label target

**Prepared PRD Issue**:
A PRD Issue whose umbrella branch and draft PullOps-Managed PR have been created or refreshed. Prepared does not mean the PRD's product work is complete.
_Avoid_: Done PRD, completed PRD

**PRD Auto-Advance**:
A PRD automation mode that prepares a PRD Issue and keeps starting unblocked Child Issues while Child Issue PR merges remain human-controlled.
_Avoid_: Parent auto-run, auto-coordinate

**PRD Auto-Complete**:
A PRD automation mode that includes PRD Auto-Advance and also merges finalized Child Issue PRs into the Umbrella Branch. The Umbrella PR still remains human-controlled.
_Avoid_: PRD auto-merge, full auto-merge

**PRD Child Coordination**:
The deterministic PullOps behavior that moves a Parent Issue's Child Issues and Child Issue PRs toward an Umbrella PR through PRD automation.
_Avoid_: PRD child orchestration, parent orchestration

**Umbrella Branch**:
The branch for a PRD Issue that receives merged Child Issue PRs before the PRD's Umbrella PR merges to the Target Repository's default branch.
_Avoid_: Parent branch, PRD work branch

**Umbrella PR**:
The PullOps-Managed PR from a PRD Issue's Umbrella Branch to the Target Repository's default branch.
_Avoid_: Parent PR, PRD implementation PR

**Child Issue**:
A Concrete Issue that belongs to a Parent Issue through GitHub's native sub-issue relationship.
_Avoid_: Subtask, body-linked child issue

**Child Issue PR**:
A PullOps-Managed PR for one Child Issue whose branch targets the Parent Issue's Umbrella Branch.
_Avoid_: Child issue commit, direct child commit

**Concrete Issue**:
An issue that is directly implementable by `pullops:issue:implement` and does not own Child Issues.
_Avoid_: Normal issue, task

**Adjacent Work**:
Work outside the literal issue text that is necessary to complete the issue correctly, such as updating shared tests or touching a directly involved module.
_Avoid_: Scope creep, drive-by fix

**Same-Repository PR**:
A pull request whose source branch belongs to the Target Repository, not a fork.
_Avoid_: Internal PR, local PR

**PullOps GitHub Token**:
The Target Repository secret used by label-dispatched PullOps Operation workflows when GitHub operations must push code or mutate issues and pull requests. Workflow dispatch and narrow GitHub State Synchronization workflows may use GitHub Actions' built-in token instead.
_Avoid_: PAT, agent token

**Agent-Ready PR**:
A pull request whose implementation and automated review PullOps Operations have both completed successfully and is ready for human review.
_Avoid_: Ready PR, reviewed PR

**PullOps-Managed PR**:
A pull request created by PullOps from a Parent Issue preparation or Concrete Issue implementation and tracked through its automated pre-human review workflow.
_Avoid_: Agent PR, generated PR

**Review Result**:
The structured outcome emitted by the review operation, classifying the pull request as approved, needing changes, or blocked.
_Avoid_: Review summary, verdict

**Coding Standards Pass**:
The review operation's responsibility to apply project coding standards that are not enforced by automated checks.
_Avoid_: Linting, style cleanup

**Actionable PR Feedback**:
Pull request feedback that asks for a code, test, documentation, or explanation change, whether it appears in an inline thread, review summary, or top-level comment.
_Avoid_: Review comments, requested changes

**Operation Output**:
The schema-validated structured result emitted by a Workflow-Facing Command and consumed by PullOps before it mutates GitHub state.
_Avoid_: Agent response, stdout

**Review Cycle**:
One automated review pass for a PullOps-Managed PR, counted when `pr-review` runs. If the review requests changes, `pr-address-review` may respond only when the workflow still has budget for a follow-up review to approve the resulting tree.
_Avoid_: Retry, review attempt

**CI Fix Cycle**:
One automated loop where PullOps responds to failing checks on a PullOps-Managed PR, pushes a fix, and sends the PR back through review.
_Avoid_: Build retry, CI retry

**Check Failure Classification**:
The `pr-fix-ci` operation's classification of a failed check as formatting, lint, type, test, build, environment, flaky, secret, or another actionable category before changing code.
_Avoid_: CI error type, failure reason

**Branch Update**:
The PullOps Operation that cleanly brings a PR branch up to date with its base branch without AI conflict resolution.
_Avoid_: Sync, refresh branch

**Conflict Resolution**:
The PullOps Operation that uses the AI runner to resolve merge conflicts between a PR branch and its base branch.
_Avoid_: Update branch with conflicts, merge fix

**PR Finalize**:
The PullOps Operation that prepares a PullOps-Managed PR for human rebase merge.
_Avoid_: Auto-merge, merge preflight

**Logical Commit Stack**:
The final commit history shape for a PullOps-Managed PR, such as one traceable commit for an issue PR or one Child Issue Commit per merged Child Issue PR in an Umbrella Branch.
_Avoid_: Squash, cleanup commits

**Child Issue Commit**:
A logical commit in an Umbrella Branch history that corresponds to one merged Child Issue PR.
_Avoid_: Direct child commit, PRD commit, task commit

**Trigger Context**:
The record of who or what requested a PullOps Operation, which runner task executed it, and which model was selected.
_Avoid_: Commit author

**Operation Audit Comment**:
An append-only GitHub timeline entry that records human-readable evidence from one PullOps Operation, especially AI runner context such as model, model tier, reasoning effort, and known context usage. Successful AI implementation work records the audit entry on the created pull request, AI pull request work records it on the pull request, and PullOps review records it in the GitHub review body; PullOps never relies on Operation Audit Comments as resumable workflow state, and it records unknown usage as unknown rather than estimating token or cost data.
_Avoid_: PR state marker, machine state, trigger context

**PR State Marker**:
A visible section in a pull request body where PullOps records current resumable workflow state, starting with whether the pull request is managed and its current PullOps status.
_Avoid_: Hidden marker, metadata comment

**PullOps Workflow State**:
The collapsed pull request body block where PullOps records diagnostic and resumable workflow markers such as cycle counts, last operation, reviewed and finalized tree hashes, finalized head, and merge method. PullOps parses these markers only from the named workflow state block.
_Avoid_: PR state marker, audit comment, visible summary

**PullOps Link Summary**:
A human-facing issue or pull request body section that summarizes the authoritative GitHub relationships around a PullOps target. Pull request bodies emphasize related pull requests first, such as Child Issue PRs and Umbrella PRs, while issue relationships are shown only when they help orientation; the section omits base/head branch data already visible in GitHub's PR UI.
_Avoid_: Relationship database, dependency source of truth

**PullOps-Managed PR Transition**:
A single PullOps-owned change to a PullOps-Managed PR's automated workflow state, derived from a PullOps Operation outcome. It may advance, block, reroute, or complete the PR's pre-human review workflow.
_Avoid_: PR body update, label cleanup

**PR Operation Refusal**:
A PullOps Operation outcome where PullOps declines a pull request target before treating it as an active PullOps-Managed PR workflow participant. Refusals cover guardrail failures such as unsupported pull request shape or missing PullOps-managed state.
_Avoid_: Managed PR transition, failure

**Branch Prefix**:
The configured prefix used for branches created by PullOps.
_Avoid_: Namespace, branch namespace
