# Keep workflows thin

Generated PullOps workflows should own GitHub triggers, permissions, concurrency, checkout, runtime setup, and normal dependency installation, but orchestration belongs in the PullOps CLI. Workflows may perform small event-payload guards, such as skipping non-child `pull_request.closed` events before checkout, but issue and PR shape detection, label transitions, branch naming, PR body state, cycle budgets, runner prompts, idempotent state mutation, and output validation should be testable in CLI code rather than embedded as large shell scripts in workflow YAML.
