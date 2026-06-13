# Generate one workflow per operation

PullOps generates one GitHub Actions workflow file per PullOps Operation instead of one combined workflow. Separate workflows keep the Actions UI readable, allow per-operation permissions, and prevent unrelated operations from accumulating in a single large YAML file.

ADR-0039 keeps separate operation workflows but moves direct label listening into a dispatcher workflow, so status-label changes do not wake every operation workflow.
