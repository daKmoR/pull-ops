# Use target-prefixed operation names

PullOps Operation Names use the same target-kind/action grammar as Operation Labels, without the `pullops:` prefix: `prd-prepare`, `issue-implement`, and `pr-review`. Because the code is unreleased, PullOps makes this a clean break across workflow-facing commands, config keys, workflow files, operation modules, PullOps Skills, and operation-specific output buckets instead of keeping legacy aliases such as `prepare-prd`, `implement-issue`, or `review-pr`.
