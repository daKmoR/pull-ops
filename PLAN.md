# PullOps Plan

PullOps is an npm CLI package for installing AI-native GitHub pull request workflows into a repository. The v1 goal is to prove the workflow kit in this repository first: labeling a GitHub issue with `pullops:implement` should create a branch, run an implementation agent, commit changes, push, open a draft PR, run automated review and cleanup loops, and then hand an agent-ready PR to humans for final review and merge.

Humans merge by default. Auto-merge is out of scope for v1.

## V1 Shape

PullOps installs a repo-local Workflow Kit, while shared runner logic lives in `@pull-ops/cli`.

Dogfood files should exist directly in this repository before `pullops init` is productized:

```txt
.github/workflows/pullops-implement.yml
.github/workflows/pullops-review-pr.yml
.github/workflows/pullops-address-review.yml
.github/workflows/pullops-fix-ci.yml
.github/workflows/pullops-update-branch.yml
.github/workflows/pullops-resolve-conflicts.yml
.github/workflows/pullops-prepare-merge.yml

.agents/skills/pullops-implement-issue/SKILL.md
.agents/skills/pullops-implement-prd/SKILL.md
.agents/skills/pullops-review-pr/SKILL.md
.agents/skills/pullops-address-review/SKILL.md
.agents/skills/pullops-fix-ci/SKILL.md
.agents/skills/pullops-update-branch/SKILL.md
.agents/skills/pullops-resolve-conflicts/SKILL.md
.agents/skills/pullops-prepare-merge/SKILL.md

pullops.config.js
```

Full `pullops init` comes later. It should be idempotent and non-destructive, eventually using `.pullops/manifest.json` to track generated workflows and skills by content hash.

## Labels

Operation labels are explicit and separate from status labels.

Issue:

```txt
pullops:implement
```

PR:

```txt
pullops:review
pullops:address-review
pullops:fix-ci
pullops:update-branch
pullops:resolve-conflicts
pullops:prepare-merge
```

Status:

```txt
pullops:in-progress
pullops:blocked
```

`pullops:implement` is shared by Leaf Issues and PRD Issues. PRD behavior is inferred from native GitHub sub-issues. Applying `pullops:implement` directly to a sub-issue should be refused with a comment telling the human to label the parent PRD.

## Managed PR Flow

PullOps-created PRs start as drafts. Humans should only review them after implementation, automated review, CI fixing if needed, and history cleanup have completed.

Happy path:

```txt
pullops:implement
-> draft PullOps-managed PR
-> pullops:review
-> pullops:address-review loop if needed
-> pullops:fix-ci loop if needed
-> pullops:prepare-merge
-> final pullops:review
-> final CI
-> mark ready for human review
```

The PR body is a structured document updated in place. It carries the human summary and PullOps state:

```md
## Summary

## Changes

## Test Plan

## Traceability

Closes #123
PRD: #456

## PullOps

Status: Draft automation
Review cycles: 1 / 3
CI fix cycles: 0 / 2
Source: Issue #123
Triggered by: @user
Runner task: pullops-implement-issue
Model tier: high
Model: ...
Last operation: pullops:review
```

The visible PullOps section is the durable managed-PR state. The configured branch prefix is only a secondary guardrail.

## Operations

### implement-issue

Implements a Leaf Issue as written. It may perform Adjacent Work needed to complete the issue correctly, but unrelated defects or broad design problems should become follow-up candidates rather than hidden scope.

Implementation focuses on delivering behavior and satisfying automated feedback such as tests, types, linting, and formatting. It does not need to spend context enforcing coding standards that are not already in feedback loops.

Default final history is one logical commit for the issue.

### implement-prd

Runs when `pullops:implement` is applied to a PRD Issue with native GitHub sub-issues. The operation implements the next open sub-issue, closes it on success, and repeats until the PRD is complete.

Default final history is one Sub-Issue Commit per completed sub-issue. `prepare-merge` may fold review and CI noise into the relevant sub-issue commit, but should not squash an entire PRD into one commit unless the PRD is genuinely tiny.

### review-pr

Reviews the PR against the linked issue or PRD, the repo domain docs, ADRs, and project coding standards. Review is responsible for the Coding Standards Pass: it enforces project standards that are not already covered by automated checks.

Review may make small direct improvements such as tests, obvious bug fixes, and local clarity improvements. It must not silently implement missing major scope; that becomes `changes_requested`.

Review emits a structured Review Result:

```json
{
  "status": "approved",
  "summary": "...",
  "inlineComments": [],
  "replies": []
}
```

Statuses are `approved`, `changes_requested`, and `blocked`.

### address-review

Handles all Actionable PR Feedback, not just unresolved inline threads. Inputs include unresolved review threads, requested-change review summaries, top-level PR comments that ask for code changes, and PullOps review output.

Default to addressing feedback. Decline only with a substantive written reason. Defer only stale, off-topic, or non-actionable comments. After pushing changes, send the PR back through review.

### fix-ci

Classifies failed checks before changing code. Categories include formatting, lint, type, test, build, environment, flaky, secret, and other actionable failures.

It may directly fix clear formatting, lint, type, build, and legitimate test failures. It must not weaken tests, delete assertions, bypass checks, or hack around missing secrets, external outages, or flaky infrastructure failures.

For PullOps-managed draft PRs, fix-ci may run automatically within a small budget. For human-created PRs, it runs only when explicitly labeled.

### update-branch

Deterministic non-AI branch maintenance. It rebases a Same-Repository PR branch onto the configured base branch and pushes with force-with-lease when clean.

If rebase conflicts occur, it hands off to `pullops:resolve-conflicts`.

### resolve-conflicts

Runs inside Git's actual conflicted rebase state. The CLI starts the rebase, captures conflict context, invokes the AI runner to edit conflicted files and run checks, continues the rebase, repeats within a budget if more conflicts appear, then pushes with force-with-lease and sends the PR back through review.

### prepare-merge

Shapes a PullOps-managed PR into clean history before humans review and merge it. It does not merge the PR.

The agent proposes a structured Commit Plan and updated PR body sections. The CLI validates and applies the history rewrite deterministically by resetting, staging path groups, creating commits, and pushing with force-with-lease.

Default target is one commit per issue, or one Sub-Issue Commit per PRD sub-issue. A small logical commit stack is allowed when the work genuinely has separable parts.

## Runner And Config

V1 supports Codex as the default and tested runner. There is no supported multi-provider abstraction in v1.

Config is JavaScript:

```js
/** @type {import('@pull-ops/cli/types.js').PullOpsConfig} */
export default {
  baseBranch: 'main',
  branchPrefix: 'pullops',
  runner: {
    provider: 'codex',
    command: 'codex exec',
    models: {
      high: '...',
      mid: '...',
      low: '...',
    },
  },
  operations: {
    implementIssue: { modelTier: 'high' },
    implementPrd: { modelTier: 'high' },
    reviewPr: { modelTier: 'high' },
    addressReview: { modelTier: 'mid' },
    fixCi: { modelTier: 'mid' },
    updateBranch: { modelTier: 'low' },
    resolveConflicts: { modelTier: 'high' },
    prepareMerge: { modelTier: 'high' },
  },
};
```

Operations select `high`, `mid`, or `low`; they do not name concrete models. If a repository overrides model mappings, it must provide all three tiers.

The PR body records the actual runner task, model tier, and concrete model used.

## CLI Surface

Workflow-facing commands are explicit:

```txt
pullops run implement-issue --issue <number>
pullops run implement-prd --issue <number>
pullops run review-pr --pr <number>
pullops run address-review --pr <number>
pullops run fix-ci --pr <number>
pullops run update-branch --pr <number>
pullops run resolve-conflicts --pr <number>
pullops run prepare-merge --pr <number>
```

Setup helper:

```txt
pullops labels ensure
```

Generated workflows should be thin wrappers. They own triggers, permissions, concurrency, checkout, runtime setup, and normal dependency installation. The CLI owns issue/PR shape detection, refusals, branch naming, PR body state, cycle budgets, runner prompts, output validation, and label transitions.

Installed target repos should use a Local PullOps Dependency. Workflows should run the local package after the repo's normal install step rather than globally installing the latest CLI.

For dogfood, npm is enough. Productized init should later detect package managers from lockfiles and allow configured install/exec command overrides.

## Structured Outputs

Every workflow-facing command has a typed Operation Output contract. The scratch review runner is the model:

- prompt the agent for a final structured JSON block
- validate with schemas before mutating GitHub
- normalize unsafe or aliased fields
- write workflow-consumable artifacts to `OUTPUT_DIR`
- write `failure_reason.txt` on failure
- treat stdout as logs only

Operation code should live under operation-owned directories:

```txt
src/operations/implement-issue/
  run.js
  output.js
  prompt.md
  extraction.md

src/operations/review-pr/
  run.js
  output.js
  prompt.md
  extraction.md
```

Shared package modules can live under `src/github/`, `src/config/`, and similar directories.

## GitHub And Security

V1 mutates only Same-Repository PRs. Fork PR support requires a separate trust model.

Required repository secrets:

```txt
PULLOPS_GITHUB_TOKEN
<Codex runner auth secret>
```

`PULLOPS_GITHUB_TOKEN` is required instead of falling back to `GITHUB_TOKEN`, because PullOps needs label changes to trigger follow-on workflows and may need workflow-file write capability.

PullOps-created commits in GitHub Actions use:

```txt
github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>
```

Do not author commits as the human who triggered the workflow. Track trigger context in the PR body.

Commit headers use:

```txt
<type>(<module>): <short message>
```

Types: `feat`, `fix`, `docs`, `test`, `refactor`, `chore`, `build`, `ci`.

Prefer `Refs: #<issue-number>` in commits. Use `Closes #<issue-number>` in the PR body.

## Deferred

`pullops init` is the later productized selling point. It should eventually:

- install or reconcile the Workflow Kit
- add `@pull-ops/cli` as a local dependency
- create or ensure labels
- check required secrets when possible
- never ask for secret values
- avoid destructive overwrites through the Install Manifest
- eventually support smart merging for user-edited skills

Auto-merge is deferred and must be explicitly enabled if added later.
