# PullOps

PullOps helps Target Repository Maintainers turn GitHub issues into reviewed pull
requests with AI while keeping human approval boundaries explicit.

It installs a repo-local Workflow Kit: PullOps skills, GitHub Actions workflows,
configuration, and a manifest of generated files. The Target Repository keeps
the workflow visible in git, while the shared runner logic comes from the local
`@pull-ops/cli` dependency pinned by the repository lockfile.

PullOps is best at issue-to-PR workflow discipline:

- A PRD Issue is broken into Child Issues, implemented through Child Issue PRs,
  and integrated through an Umbrella Branch.
- A Concrete Issue is implemented into one PullOps-Managed PR.
- Automated implementation, review, CI repair, branch update, conflict
  resolution, and finalization happen before the final human merge.

## Remember One Thing

When you are not sure what to do next, ask your local agent to run `/pullops-go`.

`/pullops-go` is the main local entrypoint. It can list runnable PRDs and issues,
choose the right PullOps command, supervise long runs, repair PullOps failures
where possible, and stop at the next real human decision. If there is no ready
work, it guides you into `/grill-with-docs` so a new PRD or issue can be shaped.

You do not need to remember every label or command. The rest of this README is
reference for the paths `/pullops-go` may choose.

## Create Work

PullOps works best when the issue tracker contains clear PRD Issues, Child
Issues, and Concrete Issues.

Use the authoring skills from
[mattpocock/skills](https://github.com/mattpocock/skills) to create that work:

1. Run `/grill-with-docs` to sharpen the idea, project language, and any
   decisions worth recording.
2. Run `/to-prd` in the same agent session to publish the PRD Issue.
3. Run `/to-issues 123`, where `123` is the GitHub issue number for the PRD
   Issue, to break it into independently runnable Child Issues.
4. Run `/pullops-go`, or apply one of the PullOps labels below, to start work.

PullOps setup can detect whether optional authoring skills such as
`grill-with-docs`, `to-prd`, and `to-issues` are available. It does not invoke
remote skill installers during PullOps setup; if your agent environment does not
already provide those skills, install them separately.

## Run Work

Prefer local `/pullops-go` when a maintainer is available to supervise from their
checkout. Use GitHub labels when you want GitHub Actions to dispatch PullOps
from the repository.

### Local First

Ask the local agent:

```text
/pullops-go
```

If you name a PRD, issue, PR, or operation, `/pullops-go` selects the matching
PullOps command. If you do not name a target, it discovers open PRDs and
implementable issues and asks you to choose.

Advanced local command variants live in
[docs/operation-reference.md](./docs/operation-reference.md). The README keeps
raw `pullops run ...` commands secondary on purpose.

### GitHub Labels

Apply these labels when GitHub Actions should run PullOps:

| Priority | Label                       | Use when                                                                                                                                                                |
| -------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1        | `pullops:prd:auto-advance`  | You want PullOps to prepare a PRD and implement the currently unblocked Child Issue frontier, while humans approve and merge each Child Issue PR.                       |
| 2        | `pullops:prd:auto-complete` | You want PullOps to keep advancing through Child Issues, review/finalize them, integrate them into the Umbrella Branch, and stop before the human default-branch merge. |
| 3        | `pullops:issue:implement`   | You want PullOps to implement one Concrete Issue or manually selected Child Issue into a PullOps-Managed PR.                                                            |

`pullops:prd:auto-advance` and `pullops:prd:auto-complete` are durable PRD
automation mode labels. They stay on the PRD Issue so later Child Issue merges
can resume the selected mode. `pullops:issue:implement` is a request for one
issue implementation.

PullOps uses `pullops:human-required` only when automation needs maintainer
attention. Ordinary progress lives in issue state, pull request state, PullOps
Workflow State in PR bodies, and local run records.

## Setup

Add PullOps to the Target Repository and install the tiny setup entrypoint:

```sh
npm install --save-dev @pull-ops/cli
npx pullops init
```

Then ask your local agent to run `/pullops-setup`. It starts with setup doctor,
installs repo-local PullOps skills and agent docs, and can continue into GitHub
Actions setup when you want label-dispatched automation.

Core setup commands:

- `pullops setup doctor --profile full --json`
- `pullops setup skills --check --json`, then `pullops setup skills --json`
- `pullops setup agent-docs --check --json`, then `pullops setup agent-docs --json`

GitHub Actions setup commands:

- `pullops setup github-actions --check --json`, then `pullops setup github-actions --json`
- `pullops setup github-labels --check --json`, then, with approval,
  `pullops setup github-labels --json`

Re-run the relevant setup doctor profile after setup: `local`, `authoring`,
`github-actions`, or `full`.

### Local Credentials

Local PullOps work does not require repository Actions secrets.

- For GitHub reads, issue mutation, labels, and local publishing to GitHub, log
  in with the GitHub CLI: `gh auth login`.
- For runner work, log in to the local Codex CLI used by your configured
  PullOps runner command.

If those local tools are authenticated, local `/pullops-go` can run and publish
PullOps work without `PULLOPS_GITHUB_TOKEN` or `OPENAI_API_KEY` repository
secrets.

### GitHub Actions Credentials

Repository Actions secrets are needed only for label-dispatched GitHub Actions
automation.

Configure these secrets when you want GitHub labels to run PullOps:

- `PULLOPS_GITHUB_TOKEN`: a token that can push branches, update issues, update
  pull requests, and reconcile workflows for the Target Repository.
- `OPENAI_API_KEY`: the key passed to the Codex Action step in generated
  workflows.

`pullops setup doctor --profile github-actions --json` checks GitHub Actions
readiness. Missing or uninspectable repository secrets are reported as warnings,
because credential readiness depends on the execution path you intend to use.

## Approval Boundaries

PullOps keeps human control at the important edges:

- Child Issue PRs remain reviewable implementation units.
- `pullops:prd:auto-advance` leaves Child Issue PR merges to humans.
- `pullops:prd:auto-complete` may complete and integrate the PRD branch, but
  the final Umbrella PR merge into the default branch remains human-controlled.
- PullOps blocks with `pullops:human-required` when it cannot safely continue.

## Reference

- [PullOps Operation Reference](./docs/operation-reference.md): labels, local
  command equivalents, and workflow-facing commands.
- [CONTEXT.md](./CONTEXT.md): PullOps domain language.
- [docs/adr](./docs/adr): architectural decisions behind the workflow.
