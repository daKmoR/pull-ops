# Treat credential readiness as contextual

PullOps Setup Doctor treats credentials as context-specific readiness signals rather than unconditional blockers. Local GitHub API access is always authenticated: PullOps refuses to create an unauthenticated GitHub API client. Local runs may satisfy GitHub authentication with `PULLOPS_GITHUB_TOKEN`, `GITHUB_TOKEN`, or a working `gh auth token` command on the process `PATH`. Local runs may still not need `OPENAI_API_KEY` when the configured runner authenticates through the user's agent subscription or when the selected operation path does not require that credential.

For GitHub Actions readiness, Doctor may check whether repository Actions secrets such as `PULLOPS_GITHUB_TOKEN` and `OPENAI_API_KEY` exist, but inability to inspect secret metadata is a warning rather than a blocker. A maintainer without Actions-secret access may still need to diagnose PullOps setup, and another maintainer may have already configured the secrets.
