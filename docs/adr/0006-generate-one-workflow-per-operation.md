# Generate one workflow per operation

PullOps generates one GitHub Actions workflow file per PullOps Operation instead of one combined workflow. A dispatcher workflow listens for label events and triggers the matching operation workflow through `workflow_dispatch`, so status-label changes do not wake every operation workflow. Separate operation workflows keep the Actions UI readable, allow per-operation permissions, and prevent unrelated operations from accumulating in a single large YAML file.
