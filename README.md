# PullOps

PullOps helps repository maintainers turn GitHub issues into reviewed pull
requests with AI while keeping human approval boundaries explicit.

It installs a repo-local Workflow Kit into a Target Repository. The kit includes
PullOps skills, GitHub Actions workflows, configuration, and a manifest of
generated files.

The workflow stays visible in git. Shared runner logic comes from the local
`@pull-ops/cli` dependency pinned by the repository lockfile.

## Work Shapes

PullOps supports two issue-to-PR workflows:

- A **PRD Issue** describes a larger change. PullOps breaks it into **Child
  Issues**, implements each Child Issue through a Child Issue PR, and integrates
  those PRs through an **Umbrella Branch**.
- A **Concrete Issue** is already small enough to implement directly. PullOps
  turns it into one **PullOps-Managed PR**.

Automated implementation, review, CI repair, branch update, conflict resolution,
and finalization happen before the final human merge.

## Setup

Use PullOps v1 in npm-based repositories with Node.js 22 or newer.

Add PullOps to the Target Repository and install the setup entrypoint:

```sh
npm install --save-dev @pull-ops/cli
npx pullops init
```

Then ask your local agent to run `/pullops-setup`. This is a repo-local agent
skill installed by `pullops init`, not a shell command.

`/pullops-setup` starts with setup doctor, installs repo-local PullOps skills and
agent docs, and can continue into GitHub Actions setup when you want
label-dispatched automation.

### Local Credentials

Local PullOps work does not require repository Actions secrets.

- For GitHub reads, issue mutation, labels, and local publishing to GitHub, log
  in with the GitHub CLI: `gh auth login`.
- For runner work, log in to the local agent CLI used by your configured
  PullOps Runner Command: the Codex CLI by default, or the Claude Code CLI when
  the Runner Command runs `claude`.

### Choose the Runner

PullOps runs the Codex CLI by default. To run the Claude Code CLI instead,
point the Runner Command at `claude` in `pullops.config.js`:

```js
export default {
  runner: {
    command: 'claude --permission-mode bypassPermissions',
  },
};
```

When the Runner Command runs `claude` and `runner.models` is not overridden,
the model tiers default to `claude-opus-4-8` (high), `claude-sonnet-5` (mid),
and `claude-haiku-4-5` (low). Generated GitHub Actions workflows switch from
the Codex Action to the Claude Code Action; rerun `pullops setup github-actions`
after changing the Runner Command so the workflows match.

To run any other agent CLI locally, set `runner.argsTemplate`. PullOps
substitutes `{model}` and `{prompt}` placeholders, appends the prompt as the
final argument when no `{prompt}` placeholder is used, and reads the final
message from stdout:

```js
export default {
  runner: {
    command: 'my-agent chat',
    argsTemplate: ['--model', '{model}', '--message', '{prompt}'],
  },
};
```

## Remember One Thing

After setup, when you are not sure what to do next, ask your local agent to run
`/pullops-go`.

`/pullops-go` is the main local entrypoint. It can list runnable PRDs and issues,
choose the right PullOps command, supervise long runs, repair PullOps failures
where possible, and stop at the next real human decision.

If there is no ready work, `/pullops-go` guides you into `/grill-with-docs` so a
new PRD or issue can be shaped.

You do not need to remember every label or command. The rest of this README is
reference for the paths `/pullops-go` may choose.

## Create Work

PullOps works best when the issue tracker contains clear PRD Issues, Child
Issues, and Concrete Issues.

Use the authoring skills from
[mattpocock/skills](https://github.com/mattpocock/skills) to create that work:

1. Run `/grill-with-docs` to sharpen the idea, project language, and any
   decisions worth recording.
2. Run `/to-prd` in the same agent session to publish the PRD Issue while the
   agent still has that context.
3. Run `/to-issues 123`, where `123` is the GitHub issue number for the PRD
   Issue, to break it into independently runnable Child Issues.
4. Run `/pullops-go 123` from a clean checkout to have the local agent run PRD
   auto-complete and publish PRs with your local credentials.
5. Alternatively, add `pullops:prd:auto-complete` to the PRD Issue to dispatch
   GitHub Actions using repository secrets.

PullOps setup can detect whether optional authoring skills such as
`grill-with-docs`, `to-prd`, and `to-issues` are available. It does not invoke
remote skill installers during PullOps setup.

If your agent environment does not already provide those skills, install them
separately from [mattpocock/skills](https://github.com/mattpocock/skills).

## Run Work

Prefer local `/pullops-go` when a maintainer is available to supervise from their
clean checkout. Local runs are easier to supervise and repair, and they use local
GitHub and runner authentication.

Use GitHub labels when you want unattended GitHub Actions automation from the
repository. Label-dispatched runs use repository Actions secrets.

### Local First

Ask the local agent:

```text
/pullops-go
```

If you name a PRD, issue, PR, or operation, `/pullops-go` selects the matching
PullOps command. If you do not name a target, it discovers open PRDs and
implementable issues and asks you to choose.

Examples:

```text
/pullops-go 123
/pullops-go issue 123
/pullops-go pr:review 456
```

Lower-level command variants live in
[docs/operation-reference.md](./docs/operation-reference.md). The README keeps
`pullops run ...` commands secondary on purpose.

### Local GitHub Credentials

Local setup and operation commands authenticate GitHub API calls from
`PULLOPS_GITHUB_TOKEN`, `GITHUB_TOKEN`, or `gh auth token` in the current
process. Sandboxed agents may not see the host machine's `gh` credentials; in
that case, forward `GITHUB_TOKEN` into the sandbox through Codex config. The
Claude Code CLI inherits the host environment by default, so it needs no
equivalent step.

In a trusted host shell, check whether `GITHUB_TOKEN` is present without printing
the token:

```sh
test -n "${GITHUB_TOKEN:-}"
```

If it is not set, prefer adding a command-backed export such as this to your
shell startup file instead of storing the raw token there:

```sh
export GITHUB_TOKEN="$(gh auth token)"
```

Add the same token to `~/.codex/.env` as `GITHUB_TOKEN=...`, keep that file
private, and configure Codex to pass the variable into shell sessions:

```toml
[shell_environment_policy]
include_only = ["GITHUB_TOKEN"]
```

If `include_only` already exists, add `GITHUB_TOKEN` to the existing list rather
than replacing unrelated entries. Restart Codex after changing host env or Codex
config. Do not print GitHub tokens with `echo`, paste them into chat, commit
them, or include them in logs.

### GitHub Actions Credentials

Repository Actions secrets are needed only for label-dispatched GitHub Actions
automation.

Configure these secrets when you want GitHub labels to run PullOps:

- `PULLOPS_GITHUB_TOKEN`: a token that can push branches, update issues, update
  pull requests, and reconcile workflows for the Target Repository. In GitHub
  terms, it needs write access for contents, issues, pull requests, and actions.
- `OPENAI_API_KEY`: the key passed to the Codex Action step in generated
  workflows when the configured Runner Command runs Codex (the default).
- `ANTHROPIC_API_KEY`: the key passed to the Claude Code Action step in
  generated workflows when the configured Runner Command runs `claude`.

`pullops setup doctor --profile github-actions --json` checks GitHub Actions
readiness. Missing or uninspectable repository secrets are reported as warnings,
because credential readiness depends on the execution path you intend to use.

### GitHub Labels

Apply these labels when GitHub Actions should run PullOps:

- Use `pullops:prd:auto-advance` when you want PullOps to prepare a PRD and
  implement the currently unblocked Child Issue frontier. Humans still approve
  and merge each Child Issue PR.
- Use `pullops:prd:auto-complete` when you want PullOps to keep advancing
  through Child Issues, review and finalize them, integrate them into the
  Umbrella Branch, and stop before the human default-branch merge.
- Use `pullops:issue:implement` when you want PullOps to implement one Concrete
  Issue or manually selected Child Issue into a PullOps-Managed PR.

`pullops:prd:auto-advance` and `pullops:prd:auto-complete` are durable PRD
automation mode labels, meaning PullOps does not remove them after one run. They
stay on the PRD Issue so later Child Issue merges can resume the selected mode.

`pullops:issue:implement` is a request for one issue implementation. PullOps
removes one-shot request labels when the request is fulfilled.

PullOps uses `pullops:human-required` when automation needs maintainer
attention. Ordinary progress lives in issue state, pull request state, PullOps
Workflow State in PR bodies, and local run records.

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
- [Run Scorecard](./docs/run-scorecard.md): aggregate Local Run Records into
  outcome metrics and capture baselines before behavior changes.
- [CONTEXT.md](./CONTEXT.md): PullOps domain language.
- [docs/adr](./docs/adr): architectural decisions behind the workflow.
