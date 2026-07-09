# Use JSONL progress events for agent-observable runs

Long-running PullOps Human-Facing Commands need an agent-observable output surface that does not require agents to ingest verbose logs for 30 minute to 2 hour runs. PullOps will expose bounded domain-level JSON Lines progress events for this mode, with the terminal event carrying the PullOps Run Summary, so an observing agent can parse one stdout stream incrementally and treat `run.summary` as the final machine-readable result. In event-stream mode stdout is machine-only; human-readable logs must go to stderr or the Local Run Record. Plain final-result JSON can remain a separate compact mode, but the long-running progress contract is a single parseable event stream rather than mixed progress JSONL plus a separate summary document. The terminal summary must include run duration as machine-readable milliseconds, optional start and finish timestamps, and known context usage centered on used tokens so long-running completions can be reported without reopening verbose artifacts. When runner usage is unavailable, the terminal payload still includes `contextUsage: null` instead of omitting the field or estimating values.

Terminal `run.summary.status` uses PullOps' broad operation outcome vocabulary: `accepted`, `blocked`, `refused`, or `failed`. `accepted` means PullOps completed the requested run path successfully, even when a later human merge is still intentionally pending; `blocked` means PullOps needs maintainer or external action; `refused` means the target failed guardrails; and `failed` means an unexpected tool or runtime error interrupted the run.

Every progress event repeats its run identity fields, including schema version, event name, run id, Operation Label Reference, and target. This makes individual events useful when sampled, copied, buffered, or inspected independently instead of requiring consumers to reconstruct context from the first line of the stream.

PullOps also persists the same JSONL event stream in the Local Run Record as `events.jsonl`, and persists the terminal `run.summary` payload by itself as `result.json`. This gives agents and scripts a compact resumable artifact for later inspection while verbose stdout, stderr, runner output, and patch artifacts remain separate. PullOps does not need a separate completion marker such as `finished.json`; `result.json` is the terminal machine-readable artifact, and the `run.summary` JSONL event is the terminal stream marker.

The event stream `runId` is the Local Run Record directory name. Events may also include the Local Run Record path, but PullOps does not introduce a second correlation identifier for the same run.

For Spec Auto-Complete, the parent event stream summarizes Ticket progress and links to child Local Run Records instead of embedding each ticket operation's full event stream inline. The parent stream is also the default supervision surface for nested Ticket work: it must expose bounded ticket liveness facts needed for observe/wait decisions, while each ticket operation keeps its own compact event stream and artifacts for debugging and post-run inspection. The parent `run.summary` includes ticket summaries and child run record paths.

Progress events may include a short human display `message`, but message text is not parseable state. Consumers must rely on structured fields for behavior and can show the message directly for concise progress updates.

Every progress event includes an `at` timestamp. The terminal summary still carries `startedAt`, `finishedAt`, and `durationMs`; per-event timestamps let observing agents detect stalls and compute phase durations without inspecting process state.

Event names use a small fixed `noun.verb` vocabulary such as `run.started`, `phase.started`, `phase.completed`, `ticket.started`, `ticket.progress`, `child.heartbeat`, `ticket.completed`, `ticket.blocked`, `waiting`, and `run.summary`. Operation-specific details belong in structured fields such as `phase`, `operation`, `ticket`, and `pullRequest`, not in bespoke event names.

`waiting` is a nonterminal event for valid in-run waits such as pending checks or retry delays. A run that cannot continue reports that terminal boundary through `run.summary.status = "blocked"` with structured blockers and next steps.

Terminal summaries use a uniform `blockers` array instead of relying only on prose or operation-specific fields such as blocked issue numbers. Each blocker identifies its target kind, number where available, phase, Operation Label Reference when applicable, machine-readable reason, display message, and whether retrying later is expected to help.

Terminal summaries include both display-oriented `nextSteps` strings and structured `suggestedActions`. Observing agents may use `nextSteps` for human updates, but automation decisions should use `suggestedActions` rather than scraping commands out of prose. Suggested command actions use argv arrays rather than shell strings so PullOps does not encode quoting, chaining, or shell parsing behavior in the agent-facing contract.

Suggested actions are advisory. Each action declares whether it requires approval and why, leaving the observing agent or human operator to apply its own autonomy policy instead of making the PullOps CLI responsible for deciding which follow-up actions may run automatically.

Routine progress events may include compact aggregate counters, such as completed, total, and blocked Ticket counts for Spec automation. These counters let observing agents report useful heartbeats from a single event without expanding the full ticket result list on every line.

## JSONL Contract

Each stdout line in event-stream mode is exactly one JSON object. There is no pretty-printed JSON, banner text, git trace, runner log, or other prose on stdout.

### Common identity fields

Every event repeats these top-level identity fields:

- `schemaVersion`: currently `1`
- `event`: stable event name such as `run.started`
- `runId`: the Local Run Record directory name
- `operation`: canonical Operation Name such as `spec-auto-complete`
- `operationLabelReference`: short Operation Label Reference such as `spec:auto-complete`
- `target`: `{ "type": "issue" | "pr", "number": <number> }`
- `at`: emission timestamp captured when PullOps writes the line

Optional identity-adjacent fields such as `mode`, `publicationMode`, `localRunRecord`, `message`, `ticket`, and `pullRequest` may appear where relevant.

### Event names

The initial fixed vocabulary is:

- `run.started`: the Human-Facing Command began
- `phase.started`: PullOps entered a meaningful domain phase
- `phase.completed`: PullOps completed a meaningful domain phase
- `ticket.started`: Spec Ticket Coordination started a Ticket unit of work
- `ticket.progress`: PullOps observed a bounded nested Ticket milestone while the Ticket operation is still running
- `child.heartbeat`: PullOps observed liveness for an active Ticket operation without claiming semantic progress
- `ticket.completed`: a Ticket unit of work reached a non-blocked result
- `ticket.blocked`: a Ticket hit a terminal blocker for this run
- `waiting`: PullOps is still validly running but is waiting on checks, review, or another nonterminal boundary
- `run.summary`: the terminal PullOps Run Summary

Operation-specific facts stay in structured fields such as `phase`, `status`, `ticket`, `pullRequest`, `ticketCounts`, `blockers`, and `suggestedActions`.

`child.heartbeat` events include the active child run identity and bounded liveness fields such as `localRunRecord`, `heartbeatAt`, `leaseExpiresAt`, `heartbeatCount`, `heartbeatSummary`, and `completedNonHeartbeatStepsSinceHeartbeat`. PullOps emits one `child.heartbeat` event for each distinct child heartbeat count received through the parent event sink. Consumers may use these events to keep waiting while the ticket lease is fresh or to decide when liveness reconciliation is needed. Consumers must not report `child.heartbeat` as semantic progress; human-facing supervisors may throttle or coalesce heartbeat display.

### Terminal summary fields

The terminal `run.summary` event carries the PullOps Run Summary. Common fields are:

- `status`: `accepted` | `blocked` | `refused` | `failed`
- `summary`: concise authoritative outcome summary
- `startedAt`, `finishedAt`, `durationMs`: machine-readable Run Duration fields
- `contextUsage`: known Context Usage or `null`
  - Known usage with limit: `"contextUsage": { "used": 1200, "limit": 200000 }`
  - Known usage without limit: `"contextUsage": { "used": 1200 }`
  - Unknown usage: `"contextUsage": null`
- `nextSteps`: optional human-readable follow-up strings
- `suggestedActions`: optional structured advisory actions
- `blockers`: required for blocked terminal boundaries

Spec Auto-Complete summaries may also include `tickets`, `parentPullRequest`, `virtualCompletedTickets`, `remainingBlockedTickets`, and `localRunRecord`.

### Blockers

Each PullOps Run Blocker uses this shape:

```json
{
  "targetKind": "issue" | "pull-request",
  "targetNumber": 101,
  "phase": "review",
  "operationLabelReference": "pr:review",
  "reason": "review-wait",
  "message": "Ticket PR #101 is waiting for human review or merge gates.",
  "retryable": true
}
```

### Suggested actions

The initial structured action shape is:

```json
{
  "kind": "command",
  "description": "Rerun Spec auto-complete after the waiting boundary clears.",
  "argv": ["pullops", "run", "spec:auto-complete", "123", "--publish", "pr"],
  "approvalRequired": false
}
```

`approvalReason` may also appear when PullOps knows why an operator should require approval.

## Representative Streams

Accepted local Spec Auto-Complete:

```jsonl
{"schemaVersion":1,"event":"run.started","runId":"2026-06-20T101500000Z-spec-auto-complete-123","operation":"spec-auto-complete","operationLabelReference":"spec:auto-complete","target":{"type":"issue","number":123},"phase":"run","message":"Starting local Spec auto-complete for issue #123.","at":"2026-06-20T10:15:00.000Z"}
{"schemaVersion":1,"event":"phase.started","runId":"2026-06-20T101500000Z-spec-auto-complete-123","operation":"spec-auto-complete","operationLabelReference":"spec:auto-complete","target":{"type":"issue","number":123},"phase":"ticket-coordination","message":"Coordinating tickets for issue #123.","at":"2026-06-20T10:15:00.050Z"}
{"schemaVersion":1,"event":"ticket.completed","runId":"2026-06-20T101500000Z-spec-auto-complete-123","operation":"spec-auto-complete","operationLabelReference":"spec:auto-complete","target":{"type":"issue","number":123},"phase":"ticket-coordination","ticket":{"number":34,"url":"https://github.test/issues/34"},"status":"merged","message":"Merged finalized ticket PR #101 locally into Spec issue #123.","pullRequest":{"number":101,"url":"https://github.test/pull/101","baseBranch":"pullops/spec-123","headBranch":"pullops/spec-123-issue-34"},"at":"2026-06-20T10:15:02.000Z"}
{"schemaVersion":1,"event":"ticket.completed","runId":"2026-06-20T101500000Z-spec-auto-complete-123","operation":"spec-auto-complete","operationLabelReference":"spec:auto-complete","target":{"type":"issue","number":123},"phase":"ticket-coordination","ticket":{"number":36,"url":"https://github.test/issues/36"},"status":"merged","message":"Merged finalized ticket PR #102 locally into Spec issue #123.","pullRequest":{"number":102,"url":"https://github.test/pull/102","baseBranch":"pullops/spec-123","headBranch":"pullops/spec-123-issue-36"},"at":"2026-06-20T10:16:00.000Z"}
{"schemaVersion":1,"event":"phase.completed","runId":"2026-06-20T101500000Z-spec-auto-complete-123","operation":"spec-auto-complete","operationLabelReference":"spec:auto-complete","target":{"type":"issue","number":123},"phase":"ticket-coordination","ticketCounts":{"total":2,"completed":2,"blocked":0},"message":"Coordinated 2 ticket(s) for issue #123: 2 completed, 0 blocked.","at":"2026-06-20T10:16:30.000Z"}
{"schemaVersion":1,"event":"run.summary","runId":"2026-06-20T101500000Z-spec-auto-complete-123","operation":"spec-auto-complete","operationLabelReference":"spec:auto-complete","target":{"type":"issue","number":123},"status":"accepted","summary":"local Spec auto-complete accepted","contextUsage":{"used":1200,"limit":200000},"startedAt":"2026-06-20T10:15:00.000Z","finishedAt":"2026-06-20T10:16:30.500Z","durationMs":90500,"at":"2026-06-20T10:16:30.500Z"}
```

Blocked local Spec Auto-Complete:

```jsonl
{"schemaVersion":1,"event":"waiting","runId":"2026-06-20T101500000Z-spec-auto-complete-123","operation":"spec-auto-complete","operationLabelReference":"spec:auto-complete","target":{"type":"issue","number":123},"phase":"ticket-coordination","ticket":{"number":34,"url":"https://github.test/issues/34"},"status":"waiting","message":"Ticket PR #101 is waiting for human review or merge gates.","pullRequest":{"number":101,"url":"https://github.test/pull/101","baseBranch":"pullops/spec-123","headBranch":"pullops/spec-123-issue-34"},"blockedPhase":"review","blockedOperation":"pr:review","at":"2026-06-20T10:18:10.000Z"}
{"schemaVersion":1,"event":"run.summary","runId":"2026-06-20T101500000Z-spec-auto-complete-123","operation":"spec-auto-complete","operationLabelReference":"spec:auto-complete","target":{"type":"issue","number":123},"status":"blocked","summary":"local Spec auto-complete reached a waiting boundary","blockers":[{"targetKind":"pull-request","targetNumber":101,"phase":"review","operationLabelReference":"pr:review","reason":"review-wait","message":"Ticket PR #101 is waiting for human review or merge gates.","retryable":true}],"nextSteps":["Wait for ticket #34 to finish review or checks, then rerun Spec auto-complete."],"suggestedActions":[{"kind":"command","description":"Rerun Spec auto-complete after the waiting boundary clears.","argv":["pullops","run","spec:auto-complete","123","--publish","pr"],"approvalRequired":false}],"contextUsage":null,"startedAt":"2026-06-20T10:15:00.000Z","finishedAt":"2026-06-20T10:18:10.500Z","durationMs":190500,"at":"2026-06-20T10:18:10.500Z"}
```

Refused local Spec Auto-Complete:

<!-- prettier-ignore -->
```jsonl
{"schemaVersion":1,"event":"run.summary","runId":"2026-06-20T101500000Z-spec-auto-complete-34","operation":"spec-auto-complete","operationLabelReference":"spec:auto-complete","target":{"type":"issue","number":34},"status":"refused","summary":"Issue #34 is already part of parent issue #12. Spec automation can only run on a Parent Issue.","displayMessage":"Issue #34 is already part of parent issue #12. Spec automation can only run on a Parent Issue.","reason":"wrong-target","nextSteps":["Run Spec auto-complete on Parent Issue #12 instead."],"suggestedActions":[{"kind":"command","description":"Run Spec auto-complete on Parent Issue #12 instead.","argv":["pullops","run","spec:auto-complete","12"],"approvalRequired":false}],"contextUsage":null,"startedAt":"2026-06-20T10:15:00.000Z","finishedAt":"2026-06-20T10:15:01.000Z","durationMs":1000,"at":"2026-06-20T10:15:01.000Z"}
```

Failed local Spec Auto-Complete:

<!-- prettier-ignore -->
```jsonl
{"schemaVersion":1,"event":"run.summary","runId":"2026-06-20T101500000Z-spec-auto-complete-123","operation":"spec-auto-complete","operationLabelReference":"spec:auto-complete","target":{"type":"issue","number":123},"status":"failed","summary":"Local Spec auto-complete for issue #123 failed unexpectedly.","displayMessage":"Local Spec auto-complete for issue #123 failed unexpectedly.","failureReason":"git exploded","contextUsage":{"used":1200,"limit":200000},"startedAt":"2026-06-20T10:15:00.000Z","finishedAt":"2026-06-20T10:15:00.250Z","durationMs":250,"at":"2026-06-20T10:15:00.250Z"}
```

Event-stream mode suppresses the existing final pretty-printed JSON on stdout. Its terminal result is the `run.summary` JSONL line; callers that want only the final JSON object should use a separate final-result JSON mode instead of mixing output formats.

When PullOps catches an unexpected failure in event-stream mode, it should best-effort emit a terminal `run.summary` with `status = "failed"` before exiting nonzero. Consumers must still handle truncated streams with no `run.summary`, treating them as interrupted or unknown and falling back to the Local Run Record or process exit state.

Exit codes in event-stream mode reflect command execution health rather than workflow completeness. `accepted` exits zero, and a cleanly reached `blocked` workflow boundary may also exit zero when PullOps emits structured blockers and suggested actions; `refused`, `failed`, usage errors, and unexpected runtime errors exit nonzero.
