# Use pr-finalize for history cleanup

PullOps v1 includes pr-finalize as the operation that shapes a PullOps-Managed PR for human rebase merge. For standalone Concrete Issue PRs and Child Issue PRs, pr-finalize deterministically rewrites the reviewed tree to one traceable commit, records finalized tree and head markers in the PR body, waits for finalized-head checks, and never merges the PR automatically. pr-finalize runs automatically for PullOps-Managed draft PRs, while human-created PRs require an explicit `pullops:pr:finalize` Operation Label because the operation rewrites history.
