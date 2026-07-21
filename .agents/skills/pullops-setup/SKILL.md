---
name: pullops-setup
description: Setup and configure PullOps in the repository.
disable-model-invocation: true
---

# PullOps Setup Skill

PullOps setup is a readiness loop: inspect with `--check`, reconcile only needed setup areas, then verify with doctor. Finish only when the final full doctor has no blockers.

## Command Form

Before running any PullOps CLI command, read and follow
[`docs/agents/pullops-cli.md`](../../../docs/agents/pullops-cli.md) if it exists.
This setup skill also runs before agent docs may be installed, so use this
bootstrap command form until the central doc is available:

`npm_config_cache=/tmp/pullops-npm-cache npm exec -- pullops <args>`

If `npm_config_cache` is already set to a sandbox-writable cache path, keep the existing value. The `--` immediately after `exec` is required so npm passes flags such as `--profile`, `--check`, and `--json` to PullOps. Do not use `npm config set cache`; keep the cache override scoped to the command or current process. If a setup command exits nonzero but prints JSON, read the JSON before treating the command as a tool failure; incomplete setup is reported through structured blockers and warnings.

## Start

1. Work from the repository root. If a setup command says this is not the root, rerun from the reported root.
2. Record local changes before reconciliation so setup does not overwrite user work. Keep git staging and commits untouched throughout.
3. Make sure GitHub Authentication is ready before moving forward, before running the doctor command. If GitHub authentication is missing, follow the GitHub Authentication instructions below.
4. Run `setup doctor --profile full --json` first and read `status`, `changesNeeded`, `blockers`, `warnings`, and `suggestions`.

Completion criterion: every blocker and warning is classified as one of:

* local action
* remote approval
* external credential handoff
* external wait

## GitHub Authentication

GitHub API authentication is contextual readiness. PullOps can use `GITHUB_TOKEN` or `GH_TOKEN`, but only when a credential is visible to the current process.

If a sandboxed Codex agent reports missing GitHub authentication (Claude Code inherits the host environment by default, so these Codex sandbox steps do not apply there — go to step 4 or 5 when the token is missing):

1. Check for a visible token without printing it:
```sh
test -n "${GITHUB_TOKEN:-}${GH_TOKEN:-}"
```

2. If no token is visible, assume `gh auth token` may not work inside the sandbox. Ask the user to run this command outside the sandbox and confirm when done:
```sh
mkdir -p "$HOME/.codex"

TOKEN="$(gh auth token)"
touch "$HOME/.codex/.env"
chmod 600 "$HOME/.codex/.env"

grep -Ev '^(GITHUB_TOKEN|GH_TOKEN)=' "$HOME/.codex/.env" > "$HOME/.codex/.env.tmp"
printf 'GITHUB_TOKEN=%s\nGH_TOKEN=%s\n' "$TOKEN" "$TOKEN" >> "$HOME/.codex/.env.tmp"
mv "$HOME/.codex/.env.tmp" "$HOME/.codex/.env"
chmod 600 "$HOME/.codex/.env"
```

3. If the user approves filesystem access outside the repository, the agent may create or modify `~/.codex/.env` itself using the same command above. Do not do this without explicit approval.
4. If the command fails because `gh` is not installed, report that GitHub CLI is missing and ask the user to install GitHub CLI or provide a token through the environment.
5. If the command fails because the user is not authenticated, ask the user to run:
```sh
gh auth login
```
Then ask the user to rerun the token persistence command from step 2.

6. Ensure the repository-local Codex config forwards the variables to spawned commands:

```toml
# .codex/config.toml

[shell_environment_policy]
include_only = ["PATH", "HOME", "GITHUB_TOKEN", "GH_TOKEN"]
```

If an include_only list already exists, add GITHUB_TOKEN and GH_TOKEN to the existing list rather than replacing unrelated entries.

7. If using the Codex app or a long-running Codex process, restart it after changing `~/.codex/.env`.

Do not print tokens with `echo`, paste them into chat, commit them, or include them in logs. Do not store token values in repo-local `.codex/config.toml` or any other repository file.


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
- Keep `.pullops/install-manifest.json` synchronized only with PullOps-owned generated files such as bundled skills and workflow files, not with the target-owned `pullops.config.mjs` or legacy `pullops.config.js`.
