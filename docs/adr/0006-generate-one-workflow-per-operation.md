# Generate one workflow per operation

PullOps generates one GitHub Actions workflow file per PullOps Operation instead of one combined workflow. Separate workflows keep the Actions UI readable, allow per-operation permissions, and prevent unrelated operations from accumulating in a single large YAML file.
