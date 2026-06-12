# Make init idempotent and non-destructive

PullOps Init should be safe to run repeatedly against the same Target Repository. It should reconcile the Workflow Kit, report missing secrets and setup gaps, and leave the repository ready to use once required secrets exist, while refusing to destroy or silently overwrite user-owned changes.
