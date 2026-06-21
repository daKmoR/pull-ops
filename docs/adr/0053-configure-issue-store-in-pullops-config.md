# Configure Issue Store in PullOps Config

PullOps exposes PRD Issue, Child Issue, Concrete Issue, and Issue Dependency persistence through an Issue Store configured in PullOps Config. Repo-local issue tracker instructions should point upstream skills such as `to-prd` and `to-issues` at PullOps CLI publish commands instead of tracker-specific creation commands, because PullOps owns the work-shape invariants while each Issue Store adapter owns the configured Issue Tracker translation.

Review Follow-up Issues are also Issue Store publications: PullOps should create them as Concrete Issues with source links from structured review proposals instead of bypassing the Issue Store through tracker-specific issue creation.

PullOps Config should include `issueStore.provider` even in v1, but v1 only supports `github`. PullOps may default `issueStore.provider` to `github` when the Target Repository has a GitHub remote; non-GitHub repositories must configure the provider explicitly. A local-markdown Issue Store adapter should be supported later once the structured request and response contract is stable.

PullOps Init should install repo-local issue tracker instructions that describe PullOps as the issue tracker from upstream skills' perspective and route PRD, Child Issue, and Concrete Issue publication through `pullops issues ...` commands.

This deliberately keeps ordinary GitHub label mutations, comments, and other non-issue tracker mutations on direct client paths rather than turning the Issue Store into a generic Issue Tracker wrapper.

Issue Store commands may orchestrate direct label operations after Issue Store publication, such as applying configured triage labels, but label mutation itself remains on the existing direct client path rather than inside the Issue Store interface.
