# Namespace labels and dispatch operation workflows

PullOps uses namespaced Operation Labels with the `pullops:<target-kind>:<operation>` grammar and namespaced Status Labels with the `pullops:status:<state>` grammar. A dispatcher workflow listens for GitHub label events and triggers the separate operation workflows through `workflow_dispatch`, preserving per-operation workflow readability and permissions while reducing Actions noise from status-label changes to a single skipped dispatcher run.

Status Labels stay in GitHub labels because they provide useful repository filtering for human follow-up, especially blocked and failed work. They are state markers, not operation requests, and must remain separate from Operation Labels.

PRD preparation success uses `pullops:status:prepared`, not `pullops:status:done`, because the PRD target still owns downstream child work. `pullops:status:done` remains reserved for completed work that may satisfy dependency checks.

The dispatcher uses the workflow's built-in `GITHUB_TOKEN` for `workflow_dispatch` calls, while dispatched operation workflows continue to use `PULLOPS_GITHUB_TOKEN` for repository mutation.
