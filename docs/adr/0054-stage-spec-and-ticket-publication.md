# Stage Spec and Ticket Publication

PullOps publishes Spec Issues and Tickets in separate user-approved stages instead of requiring one combined Spec-plus-ticket Issue Publication Plan. A `grill-with-docs` session should finish by using `to-spec` to publish the Spec Issue, while a later fresh session can read that issue and use `to-tickets` to propose, adjust, and publish Tickets through the Issue Store.

This keeps long design discussions from forcing ticket planning into an already cramped context window, while still letting PullOps own Spec/Ticket persistence and dependency publication.

The skill-facing CLI should reflect the staged workflow with separate structured publish commands under `pullops issues`: `publish-spec` publishes a Spec Issue, `publish-tickets` publishes a batch of Tickets under an existing Parent Issue, and `publish-issue` publishes one standalone Concrete Issue. Review Follow-up Issue creation can reuse the Concrete Issue publication path internally.

`publish-tickets` may receive the Parent Issue number from `--parent` or from the structured JSON request, but the command must reject conflicting parent values.

`publish-tickets` should allow manually created Parent Issues that do not have a PullOps Spec marker, while warning in machine-readable output. It should fail only when the Parent Issue cannot be found or is not a valid open parent for ticket publication.

Publish commands should accept structured JSON from `--file <path>` and from stdin, with file input as the documented path for auditability and context recovery.

Issue Store publish commands are Human-Facing Commands rather than Operation Label References: maintainers and agents invoke them directly, and they do not start from an existing labeled target.

The same structured commands should support updating existing Spec Issues and Tickets by force-replacing the generated issue title/body and relationships from the structured request. PullOps deliberately avoids merge or patch semantics for this path.

Publish commands are machine-facing and should emit stable JSON output with created or updated issue identifiers, URLs, parent links, and request-to-created-issue mappings. Human-readable output is secondary and must not be required for downstream agents to continue.

Each publish command should record its normalized request, JSON response, and any per-slice failures in a Local Run Record so agents and maintainers can recover after partial publication, reruns, or context resets.

Ticket publish requests use the approved `to-tickets` slice numbers as temporary slice refs for intra-batch dependencies. After publication, tracker issue numbers are authoritative; PullOps returns the slice-ref-to-issue-number mapping in JSON output.

Ticket publication is not transactional in v1. If part of a batch fails, PullOps reports which slice refs were created, updated, or failed, and reruns should be able to reuse or force-update existing PullOps-published tickets instead of rolling back external issue tracker side effects.

PullOps publication markers on Tickets should include the original slice ref so reruns can match an approved slice to an existing PullOps-published ticket under the Parent Issue. Publish input may also include an explicit tracker issue number override for repair or manual recovery.

Machine-only publication metadata belongs in hidden JSON inside an HTML comment. Human-readable publication/audit context may be rendered in a collapsible details block, matching the style used by PullOps-managed PR bodies and AI runner reports.

Force update should only apply by default to PullOps-Published Issues identified by a PullOps publication marker. Updating an unmarked manually created issue requires an explicit adoption path so PullOps does not accidentally overwrite maintainer-authored issue bodies.

The first implementation should leave explicit issue adoption and superseding out of scope while preserving the model shape needed for them later. Published issues may carry source issue links, and a future adoption operation can mark a manually created issue as PullOps-published before force updates are allowed.

For the GitHub Issue Store adapter, Ticket publication creates native GitHub sub-issues under the Parent Issue immediately rather than relying on textual parent references.

The GitHub Issue Store adapter uses PullOps' direct GitHub client and GraphQL support for native sub-issue operations. Direct `gh` CLI calls are only an escape hatch for future GitHub API gaps, not the primary Issue Store implementation path.

`to-tickets` may use subagents to explore alternative Ticket breakdowns before presenting one proposal to the user, but publication remains a single main-agent call to the Issue Store so created issue ordering and identifier mapping stay deterministic.

Issue Store publish commands accept structured issue requests instead of pre-rendered tracker Markdown. Ticket requests include the Spec user stories they cover so implementation agents know which user stories are relevant to check and verify for that slice.

Spec Issue publication should also use structured fields instead of pre-rendered tracker Markdown so PullOps owns the Spec body format, including parseable and stable user story numbering for later Ticket planning.

Structured publish requests may include a `triageRole` even though Issue Store does not directly mutate labels. The CLI can apply mapped labels through direct client paths for GitHub, while a future local-markdown adapter can render the same role as file status.

Publishing Tickets does not apply PullOps Operation Labels such as `pullops:issue:implement` by default. Publication may mark issues as ready through triage roles, but starting implementation remains an explicit operation or Spec automation step.

Publishing Spec Issues also does not apply Spec Operation Labels such as `pullops:spec:auto-complete` by default. Spec publication creates planning state; execution remains a separate explicit operation.

For Tickets created through PullOps, Issue Store publication should require feature slices to reference Spec user story numbers. Support slices such as prefactoring, test harness, migration, or infrastructure work may omit user story references only by marking the request as support work. Spec automation must still accept manually created specs and native sub-issues that omit user story references.

Rendered issue bodies should preserve upstream skill section names where possible. Ticket bodies add a user-story-reference section for the Spec user story numbers covered by that slice.
