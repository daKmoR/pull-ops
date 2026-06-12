# Install a repo-local workflow kit

PullOps installs a repo-local Workflow Kit into each Target Repository, while generated workflows invoke npm-provided Runner Logic for shared orchestration. This keeps AI behavior inspectable and editable in git without forcing every installed repository to own all runner implementation details.
