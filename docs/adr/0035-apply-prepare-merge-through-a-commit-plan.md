# Apply prepare-merge through a commit plan

The `pullops-prepare-merge` operation should have the agent propose a structured Commit Plan and updated PR body sections, while the CLI validates and applies the history rewrite. This keeps the judgment of logical grouping in the AI skill but leaves reset, staging, commit creation, and force-with-lease push under deterministic PullOps control.
