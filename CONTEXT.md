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

**Operation Module**:
The package-owned implementation directory for one PullOps Operation, containing its orchestration code, prompts, extraction instructions, and Operation Output schema.
_Avoid_: Workflow script, runner file

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

**Model Tier**:
A named runner capability tier, such as high, mid, or low, that operations select instead of naming concrete models directly.
_Avoid_: Model override, model preset

**PullOps Operation**:
A label-requested unit of issue or pull request work, such as preparing a PRD Issue, implementing a Concrete Issue, reviewing a PR, updating a branch, resolving conflicts, or preparing a PR for merge.
_Avoid_: Job, workflow, task

**Operation Label**:
A repository label that requests one PullOps Operation on the issue or pull request it is applied to. Operation Labels use the `pullops:<target-kind>:<operation>` grammar, where the target kind identifies PRD Issue, Concrete Issue, or pull request operations.
_Avoid_: Trigger label, command label, flat label

**Status Label**:
A repository label that records the current PullOps state of an issue or pull request without requesting new work. Status Labels use the `pullops:status:<state>` grammar and are mutually exclusive for a PullOps target.
_Avoid_: State label, progress label, operation label

**Parent Issue**:
An issue that represents a larger product requirement or PRD and owns implementation work through Child Issues.
_Avoid_: Epic, project

**PRD Issue**:
A Parent Issue handled through the `prd` Operation Label target kind. It represents a PRD-shaped work item, not a separate GitHub issue type.
_Avoid_: Epic, parent label target

**Child Issue**:
A Concrete Issue that belongs to a Parent Issue.
_Avoid_: Subtask, sub-issue when not referring to GitHub's native feature

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
The Target Repository secret used by PullOps operation workflows when GitHub operations must push code or mutate issues and pull requests. Workflow dispatch uses GitHub Actions' built-in token, not this token.
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
One automated loop where PullOps reviews a pull request, requests changes, addresses those changes, and reviews again.
_Avoid_: Retry, review attempt

**CI Fix Cycle**:
One automated loop where PullOps responds to failing checks on a PullOps-Managed PR, pushes a fix, and sends the PR back through review.
_Avoid_: Build retry, CI retry

**Check Failure Classification**:
The fix-ci operation's classification of a failed check as formatting, lint, type, test, build, environment, flaky, secret, or another actionable category before changing code.
_Avoid_: CI error type, failure reason

**Branch Update**:
The PullOps Operation that cleanly brings a PR branch up to date with its base branch without AI conflict resolution.
_Avoid_: Sync, refresh branch

**Conflict Resolution**:
The PullOps Operation that uses the AI runner to resolve merge conflicts between a PR branch and its base branch.
_Avoid_: Update branch with conflicts, merge fix

**Prepare Merge**:
The PullOps Operation that cleans up a PullOps-Managed PR's commit history and PR description before human review and merge.
_Avoid_: Auto-merge, merge preflight

**Logical Commit Stack**:
The final commit history shape for a PR: one commit for the main issue by default, or a small set of focused commits when the work naturally spans separable changes.
_Avoid_: Squash, cleanup commits

**Commit Plan**:
The structured prepare-merge output that proposes how the current PR diff should be grouped into a Logical Commit Stack.
_Avoid_: Rebase script, squash plan

**Child Issue Commit**:
A logical commit in a parent/child workflow that corresponds to one completed Child Issue.
_Avoid_: Sub-issue commit, PRD commit, task commit

**Trigger Context**:
The PR body record of who or what requested a PullOps Operation, which runner task executed it, and which model was used.
_Avoid_: Commit author, audit log

**PR State Marker**:
A visible section in a pull request body where PullOps records operation state that is useful to humans, such as the number of Review Cycles.
_Avoid_: Hidden marker, metadata comment

**Branch Prefix**:
The configured prefix used for branches created by PullOps.
_Avoid_: Namespace, branch namespace
