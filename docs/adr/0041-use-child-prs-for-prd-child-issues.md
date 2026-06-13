# Use child PRs for PRD child issues

PRD Issues use an Umbrella Branch named `pullops/prd-<prd-number>` and an Umbrella PR that targets the default branch, while each Child Issue uses `pullops/prd-<prd-number>/issue-<issue-number>` and opens a Child Issue PR targeting the Umbrella Branch. Child Issue PR bodies avoid GitHub closing keywords because [GitHub ignores those keywords for PRs targeting non-default branches](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue); PullOps closes the Child Issue when the Child Issue PR is merged into the Umbrella Branch, and dependency checks treat `Blocked by: #<issue>` as satisfied only when the blocking issue is closed.

The final PRD Issue remains open until the Umbrella PR merges into the default branch. Optional automation may later merge approved Child Issue PRs into the Umbrella Branch, but the Umbrella PR merge stays human-controlled by default.
