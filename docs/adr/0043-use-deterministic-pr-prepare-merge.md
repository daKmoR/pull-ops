# Use deterministic pr-prepare-merge for standalone issue PRs

PullOps prepares standalone Concrete Issue PRs for human rebase merge through deterministic checks and git rewriting, not through an AI-authored Commit Plan. This supersedes ADR-0035 for standalone default-branch issue PRs: `pr-review` records the approved tree, `pr-prepare-merge` refuses stale or unmanaged state, rewrites the reviewed tree to one traceable commit, records prepared tree/head markers and `Merge method: rebase`, waits for prepared-head checks, and only then removes draft status and PullOps labels.
