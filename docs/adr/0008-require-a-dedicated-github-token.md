# Require a dedicated GitHub token

PullOps v1 requires a `PULLOPS_GITHUB_TOKEN` secret instead of relying on `GITHUB_TOKEN` with fallback behavior. PullOps needs label mutations to trigger follow-on workflows and may need to push workflow-file changes, so an explicit token gives installs a clearer failure mode than silently adding labels that do not start the next operation.
