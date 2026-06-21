# Use setup github-labels

PullOps replaces `pullops labels ensure` with `pullops setup github-labels` before release. The new command uses a setup-shaped output contract with readiness status, setup area, summary, and created/updated/already-correct or changes-needed details, because first-time setup should live under the `pullops setup` namespace and the unreleased CLI does not need a compatibility alias.
