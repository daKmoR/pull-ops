---
name: pullops-setup
description: Setup and configure PullOps in the repository.
disable-model-invocation: true
---

# PullOps Setup Skill

PullOps setup is a readiness loop: inspect each setup area with `--check`, run only the needed reconcilers, then verify with doctor.

## Start

1. Work from the repository root. If a setup command says this is not the root, rerun from the reported root.
2. Run `npm exec pullops setup doctor --profile full --json` first and read the structured blockers and warnings. Completion criterion: every blocker and warning is classified as local action, remote approval, or external wait.
3. Keep git staging and commits untouched. Record local changes only to avoid overwriting user work.
4. Do not invoke `setup-matt-pocock-skills` or any remote skill package installer.

## Reconcile

For each setup area, use the same loop: run the `--check --json` command, read `status`, `changesNeeded`, `blockers`, and `warnings`, run the apply command only when needed and unblocked, then re-run the check until the area is ready or a real blocker remains.

- Skills: use `npm exec pullops setup skills --check --json`, then `npm exec pullops setup skills --json`.
- Agent docs: use `npm exec pullops setup agent-docs --check --json`, then `npm exec pullops setup agent-docs --json`.
- GitHub Actions: use `npm exec pullops setup github-actions --check --json`, then `npm exec pullops setup github-actions --json`.
- Re-run `npm exec pullops setup doctor --profile github-actions --json` after workflow setup to confirm GitHub Actions readiness.
- GitHub labels: use `npm exec pullops setup github-labels --check --json` to inspect PullOps labels. Ask before running `npm exec pullops setup github-labels --json` because it mutates the remote repository.
- If this checkout is not the target repository, pass `--repo OWNER/REPO` or set `GITHUB_REPOSITORY=OWNER/REPO` before running the GitHub label setup command.
- Re-run `npm exec pullops setup doctor --profile full --json` after label setup to confirm GitHub label readiness.

## Finish

- Re-run `npm exec pullops setup doctor --profile full --json` after setup to confirm readiness.
- Finish only when every reconciled setup area is ready and the final full doctor has no blockers. If warnings remain, report the exact setup area and suggested action.
- Report repo-local files changed by setup commands, remote label changes, blockers, and warnings. Do not stage, commit, or push.

## Safety

- Expect setup commands to write repo-local files; tool approval may be required for those local writes.
- Do not overwrite PullOps-owned files unless the manifest proves ownership and `--force` is explicitly needed.
- `npm exec pullops setup skills` installs only bundled PullOps-owned skills from the local `@pull-ops/cli` package dependency.
- `npm exec pullops setup agent-docs` creates missing compatible issue tracker, triage label, and domain docs without editing global agent instruction files.
- When a blocker mentions local changes in a manifest-owned file, inspect the file before deciding whether `--force` is appropriate.
- Keep `.pullops/install-manifest.json` synchronized only with PullOps-owned generated files such as bundled skills and workflow files, not with the target-owned `pullops.config.js`.
