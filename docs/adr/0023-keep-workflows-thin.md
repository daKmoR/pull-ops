# Keep workflows thin

Generated PullOps workflows should own GitHub triggers, permissions, concurrency, checkout, runtime setup, and normal dependency installation, but orchestration belongs in the PullOps CLI. Issue and PR shape detection, label transitions, branch naming, PR body state, cycle budgets, runner prompts, and output validation should be testable in CLI code rather than embedded as large shell scripts in workflow YAML.
