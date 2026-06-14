# Require structured review results

PullOps pr-review operations must emit an explicit Review Result instead of relying on absence of comments as approval. The workflow uses that result to decide whether to mark the PR ready for human review, request a pr-address-review operation, or block the PR with a clear failure reason.
