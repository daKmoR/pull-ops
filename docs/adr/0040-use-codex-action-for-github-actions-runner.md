# Use Codex Action for GitHub Actions runner

PullOps GitHub Actions workflows hard-code `openai/codex-action@v1` for Codex-backed operations instead of expecting the PullOps CLI to spawn a local `codex` binary in CI. A GitHub Action is a workflow step rather than a process-level runner, so implement and review operations split into prepare/action/finalize phases: PullOps still owns issue and PR orchestration, prompt construction, structured output validation, commits, labels, and comments, while the Codex Action owns installing, authenticating, and executing Codex.
