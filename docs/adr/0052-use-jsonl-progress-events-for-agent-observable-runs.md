# Use JSONL progress events for agent-observable runs

Long-running PullOps Human-Facing Commands need an agent-observable output surface that does not require agents to ingest verbose logs for 30 minute to 2 hour runs. PullOps will expose bounded domain-level JSON Lines progress events for this mode, with the terminal event carrying the PullOps Run Summary, so an observing agent can parse one stdout stream incrementally and treat `run.summary` as the final machine-readable result. In event-stream mode stdout is machine-only; human-readable logs must go to stderr or the Local Run Record. Plain final-result JSON can remain a separate compact mode, but the long-running progress contract is a single parseable event stream rather than mixed progress JSONL plus a separate summary document. The terminal summary must include run duration as machine-readable milliseconds, optional start and finish timestamps, and known context usage centered on used tokens so long-running completions can be reported without reopening verbose artifacts.

Terminal `run.summary.status` uses PullOps' broad operation outcome vocabulary: `accepted`, `blocked`, `refused`, or `failed`. `accepted` means PullOps completed the requested run path successfully, even when a later human merge is still intentionally pending; `blocked` means PullOps needs maintainer or external action; `refused` means the target failed guardrails; and `failed` means an unexpected tool or runtime error interrupted the run.

Every progress event repeats its run identity fields, including schema version, event name, run id, Operation Label Reference, and target. This makes individual events useful when sampled, copied, buffered, or inspected independently instead of requiring consumers to reconstruct context from the first line of the stream.

PullOps also persists the same JSONL event stream in the Local Run Record as `events.jsonl`, and persists the terminal `run.summary` payload by itself as `result.json`. This gives agents and scripts a compact resumable artifact for later inspection while verbose stdout, stderr, runner output, and patch artifacts remain separate.

The event stream `runId` is the Local Run Record directory name. Events may also include the Local Run Record path, but PullOps does not introduce a second correlation identifier for the same run.

For PRD Auto-Complete, the parent event stream summarizes Child Issue progress and links to child Local Run Records instead of embedding each child operation's full event stream inline. The parent `run.summary` includes child summaries and child run record paths, while each child operation keeps its own compact event stream and artifacts.

Progress events may include a short human display `message`, but message text is not parseable state. Consumers must rely on structured fields for behavior and can show the message directly for concise progress updates.

Every progress event includes an `at` timestamp. The terminal summary still carries `startedAt`, `finishedAt`, and `durationMs`; per-event timestamps let observing agents detect stalls and compute phase durations without inspecting process state.

Event names use a small fixed `noun.verb` vocabulary such as `run.started`, `phase.started`, `phase.completed`, `child.started`, `child.completed`, `child.blocked`, `waiting`, and `run.summary`. Operation-specific details belong in structured fields such as `phase`, `operation`, `childIssue`, and `pullRequest`, not in bespoke event names.

`waiting` is a nonterminal event for valid in-run waits such as pending checks or retry delays. A run that cannot continue reports that terminal boundary through `run.summary.status = "blocked"` with structured blockers and next steps.

Terminal summaries use a uniform `blockers` array instead of relying only on prose or operation-specific fields such as blocked issue numbers. Each blocker identifies its target kind, number where available, phase, Operation Label Reference when applicable, machine-readable reason, display message, and whether retrying later is expected to help.

Terminal summaries include both display-oriented `nextSteps` strings and structured `suggestedActions`. Observing agents may use `nextSteps` for human updates, but automation decisions should use `suggestedActions` rather than scraping commands out of prose. Suggested command actions use argv arrays rather than shell strings so PullOps does not encode quoting, chaining, or shell parsing behavior in the agent-facing contract.

Suggested actions are advisory. Each action declares whether it requires approval and why, leaving the observing agent or human operator to apply its own autonomy policy instead of making the PullOps CLI responsible for deciding which follow-up actions may run automatically.

Routine progress events may include compact aggregate counters, such as completed, total, and blocked Child Issue counts for PRD automation. These counters let observing agents report useful heartbeats from a single event without expanding the full child result list on every line.

Event-stream mode suppresses the existing final pretty-printed JSON on stdout. Its terminal result is the `run.summary` JSONL line; callers that want only the final JSON object should use a separate final-result JSON mode instead of mixing output formats.

When PullOps catches an unexpected failure in event-stream mode, it should best-effort emit a terminal `run.summary` with `status = "failed"` before exiting nonzero. Consumers must still handle truncated streams with no `run.summary`, treating them as interrupted or unknown and falling back to the Local Run Record or process exit state.

Exit codes in event-stream mode reflect command execution health rather than workflow completeness. `accepted` exits zero, and a cleanly reached `blocked` workflow boundary may also exit zero when PullOps emits structured blockers and suggested actions; `refused`, `failed`, usage errors, and unexpected runtime errors exit nonzero.
