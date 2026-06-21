# Install bundled PullOps skills

`pullops setup skills` installs only PullOps-owned skills bundled with the local `@pull-ops/cli` package, rather than delegating to a general remote skill package installer such as `skill`. Bundling skills with the local PullOps dependency keeps the Target Repository's Workflow Kit reproducible from its package lockfile, while PullOps' Install Manifest can still protect user-modified repo-local skill files during reconciliation.
