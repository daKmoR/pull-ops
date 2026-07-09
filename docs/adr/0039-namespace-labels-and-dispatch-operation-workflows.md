# Namespace labels and dispatch operation workflows

PullOps uses namespaced Operation Labels with the `pullops:<target-kind>:<operation>` grammar. A dispatcher workflow listens for GitHub label events and triggers the separate operation workflows through `workflow_dispatch`, preserving per-operation workflow readability and permissions. Merged Ticket PR closure is not label-dispatched; it is GitHub State Synchronization handled directly from `pull_request.closed`.

PullOps uses `pullops:human-required` as the only Status Label, and only when automation needs maintainer attention. Ordinary progress and completion state lives in PullOps-managed PR bodies, issue bodies, and GitHub's native issue and pull request state.

Spec automation labels are durable mode labels as well as the initial operation request. `pullops:spec:auto-advance` and `pullops:spec:auto-complete` stay on the Parent Issue so deterministic ticket-closure and PR-finalize paths can resume the active mode without re-adding a duplicate label.

Dependency checks use issue closure, so ticket dependencies are satisfied only after the blocking Ticket PR has merged and PullOps has closed the ticket.

The dispatcher uses the workflow's built-in `GITHUB_TOKEN` for `workflow_dispatch` calls, while dispatched operation workflows continue to use `PULLOPS_GITHUB_TOKEN` for repository mutation. Because GitHub records those dispatched runs as `github-actions[bot]`, the dispatcher checks that the original label actor has write, maintain, or admin repository permission before dispatching Codex-backed operation workflows. The direct pr-close-ticket workflow remains deterministic and is still triggered from `pull_request.closed`, but it uses `PULLOPS_GITHUB_TOKEN` for GitHub mutations because final-ticket closure applies `pullops:pr:review` to the Umbrella PR and that Operation Label must dispatch the next workflow.
