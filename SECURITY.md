# Security Policy

## Supported versions

Security fixes are provided for the latest `0.1.x` release while PullOps is in early access.

## Report a vulnerability

Use GitHub private vulnerability reporting for `daKmoR/pull-ops`. Do not open a public issue for a suspected vulnerability or include credentials, private source code, or repository data in public reports.

Include the affected PullOps version, execution backend, reproduction steps, impact, and any relevant sanitized logs. You should receive an initial response within three business days.

## Security boundaries

- PullOps-generated GitHub Actions accept operation requests only from actors with write-level repository access.
- PR mutation operations are restricted to same-repository branches.
- Generated third-party GitHub Actions are pinned to full commit SHAs.
- Local Run Records can contain prompts, patches, paths, and model output. `pullops init` keeps `.pullops/runs/` ignored by git, but maintainers remain responsible for protecting and removing local artifacts.
- `PULLOPS_GITHUB_TOKEN`, model API keys, and local CLI credentials must never be committed, pasted into issues, or printed in logs.
- Target Repository Maintainers should grant the dedicated GitHub token only the repository permissions documented in the README and rotate it if exposure is suspected.
