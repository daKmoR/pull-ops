---
name: pullops-setup
description: Setup and configure PullOps in the repository.
disable-model-invocation: true
---

# PullOps Setup Skill

PullOps setup is a readiness loop: inspect with `--check`, reconcile only needed setup areas, then verify with doctor. Finish only when the final full doctor has no blockers.

## Command Form

Use this command form for every PullOps CLI command:

`npm_config_cache=/tmp/pullops-npm-cache npm exec -- pullops <args>`

If `npm_config_cache` is already set to a sandbox-writable cache path, keep the existing value. The `--` immediately after `exec` is required so npm passes flags such as `--profile`, `--check`, and `--json` to PullOps. Do not use `npm config set cache`; keep the cache override scoped to the command or current process. If a setup command exits nonzero but prints JSON, read the JSON before treating the command as a tool failure; incomplete setup is reported through structured blockers and warnings.

## Start

1. Work from the repository root. If a setup command says this is not the root, rerun from the reported root.
2. Record local changes before reconciliation so setup does not overwrite user work. Keep git staging and commits untouched throughout.
3. Run `setup doctor --profile full --json` first and read `status`, `changesNeeded`, `blockers`, `warnings`, and `suggestions`. Completion criterion: every blocker and warning is classified as local action, remote approval, external credential handoff, or external wait.
4. If doctor reports missing GitHub authentication, use the GitHub Authentication branch before reconciling remote setup areas.

## GitHub Authentication

GitHub API authentication is contextual readiness. PullOps can use `PULLOPS_GITHUB_TOKEN`, `GITHUB_TOKEN`, or `gh auth token`, but only when that credential is visible to the current process.

If a sandboxed Codex agent reports missing GitHub authentication:

1. Check for a visible token without printing it, for example `test -n "${GITHUB_TOKEN:-}"`.
2. If the host has `gh`, prefer a host-side `GITHUB_TOKEN` sourced from `gh auth token`; if `gh auth token` fails, ask the user to run `gh auth login`; if `gh` is missing, ask the user to install GitHub CLI or provide a token through the environment.
3. For Codex sandboxes, tell the user to add `GITHUB_TOKEN=...` to `~/.codex/.env` and allow it through `~/.codex/config.toml`:

```toml
[shell_environment_policy]
include_only = ["GITHUB_TOKEN"]
```

If `include_only` already exists, add `GITHUB_TOKEN` to the existing list rather than replacing unrelated entries. Do not print tokens with `echo`, paste them into chat, commit them, or include them in logs.

## Reconcile

For each setup area, use the same loop: run the check command, read `status`, `changesNeeded`, `blockers`, `warnings`, and `suggestions`; run the apply command only when changes are needed and no blocker remains; then re-run the check. Completion criterion: the area is ready, or every remaining blocker is classified and reported.

- Skills: check `setup skills --check --json`; apply `setup skills --json`.
- Agent docs: check `setup agent-docs --check --json`; apply `setup agent-docs --json`.
- GitHub Actions: check `setup github-actions --check --json`; apply `setup github-actions --json`.
- Re-run `setup doctor --profile github-actions --json` after workflow setup to confirm GitHub Actions readiness.
- GitHub labels: check `setup github-labels --check --json`. Ask before applying `setup github-labels --json` because it mutates the remote repository.
- If this checkout is not the target repository, pass `--repo OWNER/REPO` or set `GITHUB_REPOSITORY=OWNER/REPO` before running the GitHub label setup command.
- Re-run `setup doctor --profile full --json` after label setup to confirm GitHub label readiness.

## Finish

- Re-run `setup doctor --profile full --json` after setup to confirm readiness.
- Finish only when every reconciled setup area is ready and the final full doctor has no blockers. If warnings remain, report the exact setup area and suggested action.
- Report repo-local files changed by setup commands, remote label changes, blockers, and warnings. Do not stage, commit, or push.

## Safety

- Expect setup commands to write repo-local files; tool approval may be required for those local writes.
- Do not overwrite PullOps-owned files unless the manifest proves ownership and `--force` is explicitly needed.
- `setup skills` installs only bundled PullOps-owned skills from the local `@pull-ops/cli` package dependency.
- Do not invoke `setup-matt-pocock-skills` or any remote skill package installer.
- `setup agent-docs` creates missing compatible issue tracker, triage label, and domain docs without editing global agent instruction files.
- When a blocker mentions local changes in a manifest-owned file, inspect the file before deciding whether `--force` is appropriate.
- Keep `.pullops/install-manifest.json` synchronized only with PullOps-owned generated files such as bundled skills and workflow files, not with the target-owned `pullops.config.js`.
