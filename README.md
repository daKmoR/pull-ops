# PullOps

PullOps is an npm CLI package for running AI-native GitHub issue and pull request
workflows from GitHub Actions.

## Workflow Labels

Operation Labels request work and are namespaced by target kind:

- `pullops:prd:prepare` creates or updates an umbrella branch and draft PR for a
  PRD issue.
- `pullops:prd:auto-advance` prepares a PRD issue if needed and drains the
  currently unblocked child issue frontier for individual review.
- `pullops:prd:auto-complete` drives the PRD branch hands-off: it implements,
  reviews, finalizes, and integrates unblocked child issues until the PRD branch
  is complete and the umbrella PR is finalized, or until automation is blocked.
- `pullops:issue:implement` implements one concrete issue; it does not coordinate
  or implement child issues.
- `pullops:pr:review` runs automated review for a PullOps-managed PR.

PullOps uses `pullops:human-required` only when automation needs maintainer
attention. Ordinary progress and completion state lives in PullOps-managed PR
body text and GitHub's native issue and pull request state.

See [PullOps Operation Reference](./docs/operation-reference.md) for the combined
command and label table.

For the current parent/child workflow:

1. Label the parent issue with `pullops:prd:prepare`.
2. PullOps opens an umbrella PR from `pullops/prd-<prd-number>` to the default
   branch. The PRD issue closes when that umbrella PR merges.
3. Label selected child issues with `pullops:issue:implement`.
4. PullOps opens each child PR from
   `pullops/prd-<prd-number>-issue-<issue-number>` to the PRD branch.
5. PullOps closes the child issue when its child PR merges into the PRD branch.
6. When every native child issue is closed, PullOps labels the umbrella PR with
   `pullops:pr:review`; an approved review then hands off to
   `pullops:pr:finalize`.

For automated parent/child orchestration, label the parent issue with
`pullops:prd:auto-advance` or `pullops:prd:auto-complete`. Both modes keep the
work on child branches targeting `pullops/prd-<prd-number>` and respect child
issue `Part of: #<prd>` and `Blocked by: #<issue>` lines. Auto-advance leaves
Child Issue PR review and merge decisions to humans. Auto-complete is hands-off
for the PRD branch: it keeps running child implementation, review, finalize, and
integration until all runnable child issues are integrated or a blocker needs
attention. After all child issues are integrated, auto-complete reviews and
finalizes the umbrella PR. The final umbrella PR merge into the default branch
remains human-controlled.

Local `pullops run prd:auto-complete <parent-issue-number>` keeps the CLI-wide
dry-run default, but its dry-run should simulate the full PRD completion path
locally instead of stopping after one child issue. Within that dry-run, a
virtually completed child issue satisfies downstream `Blocked by` dependencies
for later children in the same run. Use `--publish pr` to perform the same
completion path with GitHub mutations, pushes, pull requests, and child issue
closure.

Auto-advance stops after the currently unblocked child issue frontier. Human
Child Issue PR merges close those issues and can unblock the next frontier for a
later execution. Auto-complete keeps advancing through those frontiers itself
until the PRD branch is complete or blocked.

`Blocked by: #<issue>` dependencies are satisfied only by closed issues, so one
child issue can unblock another as soon as the blocking child PR has merged into
the PRD branch. Standalone issue PRs still target the default branch and use
GitHub closing keywords.

The `pullops-pr-close-child-issue` workflow listens for `pull_request.closed` and
runs only for merged same-repository PRs whose base branch is
`pullops/prd-<number>` and whose head branch is
`pullops/prd-<prd-number>-issue-<issue-number>`. Child PR bodies use
non-closing references such as `Refs #<issue>` and `Part of #<prd>`; PullOps
comments on and closes the child issue explicitly after the merge. After the
final native child issue closes, PullOps requests review on the umbrella PR.

## GitHub Token Setup

PullOps requires a repository secret named `PULLOPS_GITHUB_TOKEN`. The PullOps
CLI reads GitHub API auth from `PULLOPS_GITHUB_TOKEN` first, then
`GITHUB_TOKEN`, then the local GitHub CLI via `gh auth token`. The workflows
expose the install-facing secret under both names so PullOps and GitHub-aware
tools use the same credential.

For local commands such as `pullops labels ensure`, you can either export
`PULLOPS_GITHUB_TOKEN` or run `gh auth login` once and let PullOps reuse that
stored GitHub CLI authentication.

Prefer a fine-grained personal access token:

1. Open GitHub, then go to **Settings** -> **Developer settings** ->
   **Personal access tokens** -> **Fine-grained tokens**.
2. Click **Generate new token**.
3. Use `PULLOPS_GITHUB_TOKEN for daKmoR/pull-ops` as the token name. For other
   repositories, use `PULLOPS_GITHUB_TOKEN for OWNER/REPO`.
4. Set **Resource owner** to the user or organization that owns the repository.
5. Set **Repository access** to **Only select repositories**, then select this
   repository.
6. Grant these repository permissions:
   - **Contents**: read and write
   - **Issues**: read and write
   - **Pull requests**: read and write
   - **Workflows**: write, or read and write if GitHub shows both levels
7. Generate the token and copy it immediately.

Add the token as a repository Actions secret:

1. In the repository, go to **Settings** -> **Secrets and variables** ->
   **Actions**.
2. Open the **Secrets** tab.
3. Click **New repository secret**.
4. Name it `PULLOPS_GITHUB_TOKEN`.
5. Paste the token value and save it.

You can also set the secret with the GitHub CLI:

```sh
gh secret set PULLOPS_GITHUB_TOKEN --repo OWNER/REPO
```

GitHub CLI can store the token as a repository secret, but it does not create a
fine-grained personal access token for you. Create the token in GitHub, then pass
the copied token value to `gh secret set`.

If you use a machine user that is added as a repository collaborator,
fine-grained tokens currently cannot target that collaborator repository. Accept
the invite as the machine user, then create a classic personal access token from
that account with `repo` and `workflow` scopes, or `public_repo` and `workflow`
for public-only repositories. Store it as `PULLOPS_GITHUB_TOKEN`; PullOps PRs
and comments will appear as the machine user.

If fine-grained tokens are otherwise not available for your repository or
organization, use a classic personal access token only as a fallback. It needs
`repo` and `workflow` scopes, which are broader than the fine-grained
permissions above.

The label dispatcher uses the workflow's built-in `GITHUB_TOKEN` with Octokit for
`workflow_dispatch` calls, so dispatched operation workflows run as
`github-actions[bot]`. Before dispatching, the dispatcher verifies that the
original label actor has write, maintain, or admin access to the repository. The
Codex Action steps allow that bot actor only after this dispatcher gate.

`PULLOPS_GITHUB_TOKEN` is used by label-dispatched operation workflows after
dispatch for repository checkout, pushes, labels, and pull request updates. Codex
runner steps do not receive this token; PullOps prepare and finalize steps
receive it, the workflow's built-in token remains read-only on Codex jobs, and
finalize sets the authenticated `origin` URL immediately before pushing. The
automatic pr-close-child-issue synchronization workflow is deterministic, but it
also receives `PULLOPS_GITHUB_TOKEN` because final-child closure applies an
operation label to the umbrella PR and that label must dispatch the next
workflow.

## OpenAI Codex Setup

PullOps uses the configured `codex-cli` runner adapter for local CLI runs:

```sh
pullops run issue-implement --issue 42
```

GitHub Actions workflows select the `codex-action` runner adapter explicitly and
use `openai/codex-action@v1` for Codex-backed operation steps. Add a repository
Actions secret named `OPENAI_API_KEY`; the workflows pass it only to the Codex
Action step as `openai-api-key`. The workflows check for this secret before
invoking the action so missing configuration fails with a direct setup error.

```sh
gh secret set OPENAI_API_KEY --repo OWNER/REPO
```

The implement and review workflows run in three phases:

1. PullOps prepares the branch or PR context and writes
   `$RUNNER_TEMP/pullops-output/codex_prompt.md`.
2. `openai/codex-action@v1` runs Codex with that prompt and writes
   `$RUNNER_TEMP/pullops-output/codex_output.json`.
3. PullOps validates the JSON output, commits or publishes review feedback, and
   updates labels.

The workflow-facing lifecycle commands are internal workflow plumbing:

```sh
pullops run issue-implement --phase prepare --runner codex-action --issue 42
pullops run issue-implement --phase finalize --runner codex-action --runner-ran true --issue 42
```

See GitHub's docs for current UI details:

- [Managing personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)
- [Using secrets in GitHub Actions](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)
