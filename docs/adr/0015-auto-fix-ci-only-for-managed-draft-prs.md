# Auto-fix CI only for managed draft PRs

PullOps automatically runs fix-ci for PullOps-Managed PRs while they are still drafts, with a small CI Fix Cycle budget. Human-created PRs can still use `pullops:fix-ci`, but only through an explicit label, so arbitrary PRs do not self-mutate on every failed check.
