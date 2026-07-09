# PullOps

An npm CLI package for installing AI-native GitHub pull request workflows into a repository.

## Language

**Target Repository**:
The repository where PullOps installs workflows, skills, and configuration.
_Avoid_: Consumer repo, project

**Target Repository Maintainer**:
A person responsible for installing and operating PullOps in a Target Repository, including credentials, labels, and workflow choices.
_Avoid_: PullOps user, consumer

**Workflow Kit**:
The repo-local set of generated GitHub Actions workflows, agent skills, and PullOps configuration committed into a Target Repository.
_Avoid_: Scaffold, template

**PullOps Skill**:
A repo-local agent skill installed by PullOps to describe one PullOps Operation.
_Avoid_: Agent script, prompt file

**Install Manifest**:
The PullOps-owned record of generated Workflow Kit files and their installed content hashes.
_Avoid_: Lockfile, generated file list

**PullOps Config**:
The Target Repository-owned settings that control how its Workflow Kit behaves.
_Avoid_: Init options, settings file

**PullOps Init**:
The tiny CLI entry point that installs the minimum repo-local files needed for a Target Repository's agent-guided PullOps setup.
_Avoid_: Setup, bootstrap, workflow kit install

**PullOps Setup Skill**:
The repo-local agent skill installed by PullOps Init to guide an AI coding agent through Target Repository-specific PullOps setup decisions.
_Avoid_: Init script, setup command, onboarding doc

**PullOps Setup Command**:
A deterministic namespaced CLI command under `pullops setup` that installs, reconciles, checks, or reports one setup area such as skills, GitHub Actions workflows, GitHub labels, agent docs, or readiness.
_Avoid_: Init subcommand, setup skill, workflow-facing command

**PullOps Setup Doctor**:
The PullOps Setup Command that reports whether a Target Repository is ready to run PullOps locally and through its configured runner, including whether the runner can access required commands such as `node` and the local `pullops` executable.
_Avoid_: Health check, environment probe, init validation

**PullOps Label Setup**:
The PullOps Setup Command that creates or reconciles PullOps Operation Labels and PullOps Status Labels in the configured GitHub repository.
_Avoid_: Triage label setup, issue taxonomy setup

**Authoring Workflow**:
The planning path for turning a maintainer idea into PullOps-published Spec Issues and Tickets: grilling → spec → tickets, usually through authoring skills such as `grill-with-docs` (or `wayfinder` for ideas too big for one agent session), `to-spec`, and `to-tickets`.
_Avoid_: PullOps operation, manual issue entry

**Authoring Skill Availability**:
Whether optional repo-local planning and authoring skills such as `grill-with-docs`, `to-spec`, and `to-tickets` are present under `.agents/skills/` in a Target Repository.
_Avoid_: Agent capability detection, model invocation availability

**Workflow-Facing Command**:
A PullOps CLI command intended to be called by generated GitHub Actions workflows.
_Avoid_: Internal command, subcommand

**Human-Facing Command**:
A PullOps CLI command intended to be typed directly by a maintainer to run an Operation Label Reference against a target with an Execution Backend and Publication Mode.
_Avoid_: Workflow-facing command, lifecycle command

**Operation Label Reference**:
The command-line spelling of an Operation Label, using only the short `target-kind:operation` form such as `issue:implement` or `spec:auto-advance`.
_Avoid_: Operation name, full label

**Operation Module**:
The package-owned implementation directory for one PullOps Operation, containing its orchestration code, prompts, extraction instructions, and Operation Output schema.
_Avoid_: Workflow script, runner file

**Operation Catalog**:
The PullOps-owned source of truth for the fixed PullOps Operation set and their canonical operation facts, keeping Operation Names, Operation Labels, target kinds, default operation settings, and workflow-facing identity aligned.
_Avoid_: Plugin registry, workflow generator, operation list

**Local PullOps Dependency**:
The Target Repository's package-managed dependency on `@pull-ops/cli`, used by workflows instead of a global install.
_Avoid_: Global CLI, latest CLI

**Package Manager Command**:
The configured command a Workflow Kit uses to install dependencies or execute the Local PullOps Dependency.
_Avoid_: Install command, npm command

**Runner Logic**:
The maintained npm-package logic invoked by generated workflows to execute a PullOps operation.
_Avoid_: Workflow script, action code

**Runner Command**:
The Target Repository configuration that tells PullOps how to invoke the AI coding agent for a PullOps Operation. The command's executable names the agent CLI: `claude` commands drive the Claude Code CLI, and every other command keeps Codex CLI conventions.
_Avoid_: Provider config, model command

**Runner Adapter**:
The PullOps-owned execution path for running an AI coding agent. `codex-cli` runs the configured Runner Command from the PullOps CLI, while `external` splits execution across prepare, hosted runner, and finalize workflow steps.
_Avoid_: Phase, task script, provider

**Runner Lifecycle**:
The PullOps-owned flow that carries one operation runner step through a Runner Adapter, from an Operation Module's prompt to its validated Operation Output, including skipped-runner handling and failure recording.
_Avoid_: Phase handler, runner wrapper, codex helper

**Operation Descriptor**:
The one interface an Operation Module hands the Runner Lifecycle: runner-step factories, finalize ordering, and local dry-run flow as data, with declared overrides for genuinely bespoke phases. The Runner Lifecycle owns the shared entry flow so Operation Modules never re-implement it.
_Avoid_: Handler map, plugin manifest, catalog entry

**Execution Backend**:
The place where a PullOps Operation is executed, such as the active local checkout or GitHub Actions.
_Avoid_: Runner adapter, provider

**Credential Readiness**:
The context-specific authentication state needed by a selected PullOps path. Local PullOps work can rely on local GitHub and runner authentication, while GitHub Actions work depends on repository Actions secrets.
_Avoid_: Secret setup, overall readiness

**Publication Mode**:
The intended visibility and persistence of a PullOps Operation result, such as opening a pull request or leaving local changes for review.
_Avoid_: Output, execution backend

**Run Goal**:
How far a PullOps Execution Backend should continue through PullOps follow-up operations for a target.
_Avoid_: Publication mode, operation label

**PullOps Go**:
The local agent-facing entrypoint that selects, runs, supervises, and repairs PullOps work for a Target Repository Maintainer.
_Avoid_: Local CLI command, GitHub label, manual workflow

**Local Run Record**:
A visible, gitignored `.pullops/runs/<timestamp>-<operation-label-reference>-<target-number>/` directory where local execution records artifacts from one PullOps run.
_Avoid_: Hidden cache, audit store

**PullOps Event Supervision**:
The PullOps Go behavior of observing a long-running Human-Facing Command through its PullOps Progress Events, using PullOps Run State only for reconciliation, and intervening only after lease expiry and liveness reconciliation. For nested runs, the parent command's PullOps Progress Events are the default supervision surface.
_Avoid_: Log watching, process polling, artifact scraping

**PullOps Run Supervision**:
The PullOps-owned module that carries run liveness and progress signals — PullOps Heartbeats, PullOps Leases, PullOps Progress Events, and PullOps Stall Classification — between an active worker and its supervisor. It classifies stalls but never intervenes; interruption, retry, and replacement stay with the supervisor.
_Avoid_: Watchdog, monitor, supervision boundary

**PullOps Heartbeat**:
A durable machine-only liveness update reported by the active PullOps worker, separate from semantic progress and intended to prevent false intervention during long-running work.
_Avoid_: Progress event, human status update, milestone

**Child Heartbeat Event**:
A parent PullOps Progress Event emitted from a PullOps Parent Event Sink payload that proxies selected PullOps Heartbeat and PullOps Lease facts for an active Ticket run, so PullOps Event Supervision can keep waiting or classify a stall from the parent event stream without treating liveness as semantic progress.
_Avoid_: Ticket progress event, log ping, human status update

**PullOps Parent Event Sink**:
A parent-owned loopback HTTP live channel with bearer-token authentication that nested PullOps commands can publish narrow live events to while a parent Human-Facing Command is running.
_Avoid_: State polling, stdout scraping, file watcher

**PullOps Heartbeat Command**:
A deterministic local PullOps command an active worker uses to report a PullOps Heartbeat to the current Local Run Record and, when configured, publish the heartbeat payload to a PullOps Parent Event Sink.
_Avoid_: Log marker, stdout ping, progress command

**PullOps Lease**:
A durable intervention guard for a running PullOps worker that defines the earliest time a supervisor may consider recovery, while still requiring liveness reconciliation before interruption or replacement.
_Avoid_: Lock, timeout, ownership claim

**PullOps Liveness Signal**:
A live or durable observation that can extend or validate a PullOps Lease during supervision. For nested local runs, the default live signal is a Child Heartbeat Event delivered through a PullOps Parent Event Sink; PullOps Run State is the durable fallback for reconciliation and postmortem recovery.
_Avoid_: Human progress, CI status, git diff polling

**PullOps Progress Event**:
A bounded machine-readable status update from a long-running Human-Facing Command, intended for tools to observe progress without reading verbose logs.
_Avoid_: Log line, heartbeat, console output

**PullOps Run Summary**:
The final machine-readable outcome of a Human-Facing Command, identifying status, target, resulting run records, blockers, and next steps.
_Avoid_: CLI footer, agent response, verbose output

**PullOps Run State**:
The mutable machine-readable state of an in-progress local PullOps run, stored in its Local Run Record for supervision fields such as status, phase, heartbeat, lease, last event, and child runs.
_Avoid_: Run summary, event stream, verbose log

**PullOps Run Blocker**:
A structured reason a PullOps run cannot continue without maintainer action, external completion, or a later retry.
_Avoid_: Error message, failed log line, blocked issue number

**PullOps Stall Classification**:
A structured supervisor finding that a running PullOps worker appears stalled after lease expiry and liveness reconciliation, recorded before interruption, retry, or replacement.
_Avoid_: Timeout error, process kill, manual hunch

**Run Budget**:
The configured per-target resource cap for PullOps-Managed PR automation, denominated in runner-reported tokens and measured operation wall-clock time. Budget exhaustion and lack of verifiable progress are the primary continuation gates; Review Cycle and CI Fix Cycle counters remain only as telemetry and generous backstop guards.
_Avoid_: Cycle budget, retry limit, cost estimate

**Run Duration**:
The measured elapsed time for one PullOps run, reported in machine-readable milliseconds and optionally anchored by start and finish timestamps.
_Avoid_: Human duration string, timeout

**Context Usage**:
The known runner-reported token usage for a PullOps run, centered on used tokens and optionally including a context limit. Unknown usage stays unknown rather than being estimated.
_Avoid_: Billing tokens, cost estimate, guessed usage

**Operation Run Goal**:
The Run Goal where PullOps runs exactly the requested Operation Label Reference and then stops.
_Avoid_: One-shot mode

**Finalized Run Goal**:
The Run Goal where PullOps follows local PullOps follow-up operations until the pull request is finalized or blocked.
_Avoid_: Full run, final publish

**GitHub State Synchronization**:
A deterministic PullOps workflow that reconciles GitHub issue or pull request state without invoking a Runner Adapter.
_Avoid_: AI operation, runner task

**Model Tier**:
A named runner capability tier, such as high, mid, or low, that operations select instead of naming concrete models directly.
_Avoid_: Model override, model preset

**PullOps Operation**:
A label-requested unit of issue or pull request work, such as preparing a Spec Issue, implementing a Concrete Issue, reviewing a PR, updating a branch, resolving conflicts, or finalizing a PR before merge.
_Avoid_: Job, workflow, task

**Operation Name**:
The canonical target-prefixed identifier for a PullOps Operation, using the same target kind and action as its Operation Label without the `pullops:` prefix, such as `spec-prepare`, `issue-implement`, or `pr-review`.
_Avoid_: Legacy object/action names like `spec-prepare`, `issue-implement`, `pr-review`

**Operation Label**:
A repository label that requests one PullOps Operation on the issue or pull request it is applied to. Operation Labels use the `pullops:<target-kind>:<operation>` grammar, where the target kind identifies Spec Issue, Concrete Issue, or pull request operations.
_Avoid_: Trigger label, command label, flat label

**Status Label**:
A repository label that records that a PullOps target needs maintainer attention, not ordinary workflow progress. PullOps uses status labels only for exceptional human-required states rather than in-progress, prepared, or done workflow states.
_Avoid_: Progress label, completion label, operation label

**Human-Required Label**:
The PullOps Status Label applied when automation cannot safely continue without maintainer action. Normal dependency waits, prepared specs, completed issues, merged pull requests, and ready-for-merge pull requests do not use this label.
_Avoid_: Blocked-by dependency, failed state label, done label

**Parent Issue**:
An issue that represents a larger product requirement or Spec and owns implementation work through Tickets.
_Avoid_: Epic, project

**Spec**:
The published specification for a feature or change — the destination the authoring workflow writes down before tickets are cut. You may know this document as a PRD; spec is the single through-line term.
_Avoid_: PRD, requirements doc

**Spec Issue**:
A Parent Issue handled through the `spec` Operation Label target kind. It represents a spec-shaped work item, not a separate GitHub issue type.
_Avoid_: PRD Issue, epic, parent label target

**Prepared Spec Issue**:
A Spec Issue whose umbrella branch and draft PullOps-Managed PR have been created or refreshed. Prepared does not mean the Spec's product work is complete.
_Avoid_: Done Spec, completed Spec

**Spec Auto-Advance**:
A Spec automation mode that prepares a Spec Issue and drains the currently unblocked Ticket frontier while Ticket PR merges remain human-controlled.
_Avoid_: Parent auto-run, auto-coordinate

**Spec Auto-Complete**:
A Spec automation mode that drives a Spec Issue hands-off until all runnable Tickets are implemented, reviewed, finalized, integrated into the Umbrella Branch, and the Umbrella PR is reviewed and finalized. The Umbrella PR still remains human-controlled for the default-branch merge.
_Avoid_: Spec auto-merge, full auto-merge

**Spec Ticket Coordination**:
The deterministic PullOps behavior that moves a Parent Issue's Tickets and Ticket PRs toward an Umbrella PR through Spec automation.
_Avoid_: Spec ticket orchestration, parent orchestration

**Umbrella Branch**:
The branch for a Spec Issue that receives merged Ticket PRs before the Spec's Umbrella PR merges to the Target Repository's default branch.
_Avoid_: Parent branch, Spec work branch

**Umbrella PR**:
The PullOps-Managed PR from a Spec Issue's Umbrella Branch to the Target Repository's default branch.
_Avoid_: Parent PR, Spec implementation PR

**Ticket**:
A Concrete Issue that belongs to a Parent Issue through GitHub's native sub-issue relationship — one tracer-bullet vertical slice of its Spec.
_Avoid_: Child Issue, subtask, body-linked issue

**Ticket PR**:
A PullOps-Managed PR for one Ticket whose branch targets the Parent Issue's Umbrella Branch.
_Avoid_: Child Issue PR, ticket commit, direct ticket commit

**Concrete Issue**:
An issue that is directly implementable by `pullops:issue:implement` and does not own Tickets.
_Avoid_: Normal issue, task

**Issue Store**:
The PullOps-owned interface for creating, force-updating, reading, listing, and relating Spec Issues, Tickets, Concrete Issues, and Issue Dependencies in the configured Issue Tracker. Ordinary tracker-specific mutations that are not specs, sub-issues, issues, or issue relationships, such as applying GitHub labels or posting comments, stay with their direct client.
_Avoid_: Issue tracker wrapper, work store

**Issue Snapshot**:
A PullOps-shaped point-in-time read of one issue from the Issue Store, carrying its kind, parent, Issue Dependencies, and publication ownership. Mutations never go through a snapshot; they go through the Issue Store.
_Avoid_: Raw issue, tracker payload, issue facts

**PullOps-Published Issue**:
A Spec Issue, Ticket, or Concrete Issue whose generated issue content is marked as owned by PullOps Issue Store publication and can therefore be force-updated by PullOps.
_Avoid_: Managed issue, generated issue

**Issue Dependency**:
A `Blocked by` relationship from one issue to another issue that must close before the dependent issue can run.
_Avoid_: Task dependency, ordering edge

**Adjacent Work**:
Work outside the literal issue text that is necessary to complete the issue correctly, such as updating shared tests or touching a directly involved module.
_Avoid_: Scope creep, drive-by fix

**Same-Repository PR**:
A pull request whose source branch belongs to the Target Repository, not a fork.
_Avoid_: Internal PR, local PR

**PullOps GitHub Token**:
The Target Repository secret used by label-dispatched PullOps Operation workflows when GitHub operations must push code or mutate issues and pull requests. Workflow dispatch and narrow GitHub State Synchronization workflows may use GitHub Actions' built-in token instead.
_Avoid_: PAT, agent token

**Agent-Ready PR**:
A pull request whose implementation and automated review PullOps Operations have both completed successfully and is ready for human review.
_Avoid_: Ready PR, reviewed PR

**PullOps-Managed PR**:
A pull request created by PullOps from a Parent Issue preparation or Concrete Issue implementation and tracked through its automated pre-human review workflow.
_Avoid_: Agent PR, generated PR

**Review Result**:
The structured outcome emitted by the review operation, classifying the pull request as approved, needing changes, or blocked.
_Avoid_: Review summary, verdict

**Coding Standards Pass**:
The review operation's responsibility to apply project coding standards that are not enforced by automated checks.
_Avoid_: Linting, style cleanup

**Actionable PR Feedback**:
Pull request feedback that asks for a code, test, documentation, or explanation change, whether it appears in an inline thread, review summary, or top-level comment.
_Avoid_: Review comments, requested changes

**Operation Output**:
The schema-validated structured result emitted by a Workflow-Facing Command and consumed by PullOps before it mutates GitHub state.
_Avoid_: Agent response, stdout

**Review Cycle**:
One automated review pass for a PullOps-Managed PR, counted when `pr-review` runs. If the review requests changes, `pr-address-review` may respond only when the workflow still has budget for a follow-up review to approve the resulting tree.
_Avoid_: Retry, review attempt

**Escalation Review Cycle**:
The final additional high-tier automated review loop reserved for a PullOps-Managed PR after normal Review Cycles are exhausted. It is a distinct last-chance loop for productive late feedback, not a larger normal review budget.
_Avoid_: Fourth retry, lenient review, budget bump

**Review Follow-up Issue**:
A GitHub issue created from an approving Escalation Review Cycle to track non-blocking work that is worth preserving outside the current pull request. It is linked back to the PullOps-Managed PR and source issue, and starts in triage rather than as agent-ready work.
_Avoid_: Review comment, deferred blocker, automatic ticket

**Human Feedback Response Cycle**:
A separate high-tier automated loop granted by each distinct trusted human `CHANGES_REQUESTED` pull request review on a Same-Repository PullOps-Managed PR. It lets PullOps address the human feedback and run one validating review without changing the recorded Review Cycle count.
_Avoid_: Review cycle reset, free retry, budget decrement

**CI Fix Cycle**:
One automated loop where PullOps responds to failing checks on a PullOps-Managed PR, pushes a fix, and sends the PR back through review.
_Avoid_: Build retry, CI retry

**Check Failure Classification**:
The runner's judgment, within the `pr-fix-ci` operation, classifying each failed check as formatting, lint, type, test, build, environment, flaky, or secret before changing code. PullOps supplies a non-binding keyword prior with each failed check, records disagreement between the prior and the runner's classification in the Local Run Record, and only accepts repairs for actionable classifications.
_Avoid_: CI error type, failure reason, keyword classification

**Branch Update**:
The PullOps Operation that cleanly brings a PR branch up to date with its base branch without AI conflict resolution.
_Avoid_: Sync, refresh branch

**Conflict Resolution**:
The PullOps Operation that uses the AI runner to resolve merge conflicts between a PR branch and its base branch.
_Avoid_: Update branch with conflicts, merge fix

**PR Finalize**:
The PullOps Operation that prepares a PullOps-Managed PR for human rebase merge.
_Avoid_: Auto-merge, merge preflight

**Logical Commit Stack**:
The final commit history shape for a PullOps-Managed PR, such as one traceable commit for an issue PR or one Ticket Commit per merged Ticket PR in an Umbrella Branch.
_Avoid_: Squash, cleanup commits

**Ticket Commit**:
A logical commit in an Umbrella Branch history that corresponds to one merged Ticket PR.
_Avoid_: Direct ticket commit, Spec commit, task commit

**Trigger Context**:
The record of who or what requested a PullOps Operation, which runner task executed it, and which model was selected.
_Avoid_: Commit author

**Operation Audit Comment**:
An append-only GitHub timeline entry that records human-readable evidence from one PullOps Operation, especially AI runner context such as model, model tier, reasoning effort, and known context usage. Successful AI implementation work records the audit entry on the created pull request, AI pull request work records it on the pull request, and PullOps review records it in the GitHub review body; PullOps never relies on Operation Audit Comments as resumable workflow state, and it records unknown usage as unknown rather than estimating token or cost data.
_Avoid_: PR state marker, machine state, trigger context

**PR State Marker**:
A visible section in a pull request body where PullOps records current resumable workflow state, starting with whether the pull request is managed and its current PullOps status.
_Avoid_: Hidden marker, metadata comment

**PullOps Workflow State**:
The collapsed pull request body block where PullOps records diagnostic and resumable workflow markers such as cycle counts, last operation, reviewed and finalized tree hashes, finalized head, and merge method. PullOps parses these markers only from the named workflow state block.
_Avoid_: PR state marker, audit comment, visible summary

**PullOps Link Summary**:
A human-facing issue or pull request body section that summarizes the authoritative GitHub relationships around a PullOps target. Pull request bodies emphasize related pull requests first, such as Ticket PRs and Umbrella PRs, while issue relationships are shown only when they help orientation; the section omits base/head branch data already visible in GitHub's PR UI.
_Avoid_: Relationship database, dependency source of truth

**PullOps-Managed PR Transition**:
A single PullOps-owned change to a PullOps-Managed PR's automated workflow state, derived from a PullOps Operation outcome. It may advance, block, reroute, or complete the PR's pre-human review workflow.
_Avoid_: PR body update, label cleanup

**PullOps-Managed PR Transition Graph**:
The declarative managed-pr-owned graph that answers every routing question of the pre-human review workflow: which PullOps Operation follows which outcome, the allowed outcome kinds per operation, blocked follow-up operations, and state-based continuation routing. It is the routing trust boundary — verified harness structure, never runner judgment.
_Avoid_: State machine, routing table, workflow engine

**PR Operation Refusal**:
A PullOps Operation outcome where PullOps declines a pull request target before treating it as an active PullOps-Managed PR workflow participant. Refusals cover guardrail failures such as unsupported pull request shape or missing PullOps-managed state.
_Avoid_: Managed PR transition, failure

**Branch Prefix**:
The configured prefix used for branches created by PullOps.
_Avoid_: Namespace, branch namespace
