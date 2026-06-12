# Use GitHub Actions bot identity for v1 commits

PullOps v1 commits created in GitHub Actions use `github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>` as both author and committer. PullOps should not author commits as the human who triggered the workflow; instead, the PR body records Trigger Context including triggered-by, runner task, and model. A future GitHub App mode may use a real `pullops[bot]` identity once that app exists.

PullOps commit headers use `<type>(<module>): <short message>` with conventional types such as `feat`, `fix`, `docs`, `test`, `refactor`, `chore`, `build`, and `ci`. Non-trivial commits include a short body explaining the diff and relevant test or behavior impact, with `Refs: #<issue-number>` and `PRD: #<prd-number>` footers when available; PR bodies, not commits, use `Closes #<issue-number>`.
