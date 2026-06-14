---
status: superseded by ADR-0019
---

# Defer pr-prepare-merge

PullOps v1 does not include a pr-prepare-merge operation. The first Workflow Kit should focus on getting a PR from issue implementation through automated review, CI fixing, branch updates, and conflict resolution; a separate pre-merge summary or preflight operation can be added later if real usage shows it is valuable.
