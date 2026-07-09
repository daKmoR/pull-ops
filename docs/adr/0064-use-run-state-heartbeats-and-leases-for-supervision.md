# Use run state, heartbeats, and leases for supervision

PullOps Event Supervision extends ADR-0052's JSONL Progress Event stream with a mutable `state.json` in each Local Run Record. The event stream remains the semantic history and terminal summary surface, while `state.json` carries machine-only supervision state such as `status`, `phase`, `heartbeatAt`, `leaseExpiresAt`, `lastEvent`, and `childRuns`.

For nested local runs such as Spec Auto-Complete driving Ticket operations, the parent command's Progress Event stream is the complete default supervision surface. The parent command starts a PullOps Parent Event Sink and passes its local authenticated endpoint to nested PullOps commands. Child workers still record PullOps Heartbeats through the PullOps Heartbeat Command into their own `state.json`; when a parent event sink is configured, the same command also publishes the heartbeat payload to that sink. The parent coordinator converts sink payloads into `child.heartbeat` events containing the active child run, heartbeat time, lease expiry, heartbeat count, heartbeat summary, and completed non-heartbeat step count, so an observing agent can keep waiting or classify a stall without routinely opening child `state.json` files. Parent streams emit one `child.heartbeat` per distinct child heartbeat count; human-facing supervisors can throttle display separately. Child Local Run Records remain the durable recovery and postmortem surface when the stream is truncated, inconsistent, or terminal.

The PullOps Heartbeat Command's success boundary is durable heartbeat recording. If it successfully updates the child `state.json` but cannot publish to the parent event sink, the command still returns accepted and reports the sink delivery failure as warning metadata or stderr. Sink delivery is the live liveness path, not the durable record. A parent supervisor treats missing live events as a possible sink-loss condition and reconciles from durable run state only after stream interruption, sink loss, or lease expiry.

The PullOps Parent Event Sink uses loopback HTTP bound to `127.0.0.1` with an ephemeral port and an unguessable bearer token passed to nested commands through environment variables. Loopback HTTP is preferred over Unix domain sockets or file watchers because it is portable across local development and CI runners, straightforward for the Node CLI to call, and keeps liveness delivery off stdout and away from filesystem polling. The parent command closes the sink when the parent run exits.

The parent event sink is a generic nested-operation live transport, but its initial accepted payload set is deliberately narrow. The first supported payload type is `heartbeat`, not arbitrary progress data. The PullOps Heartbeat Command publishes the validated updated child run-state subset plus parent-issued routing fields:

```json
{
  "type": "heartbeat",
  "parentRunId": "2026-06-30T160737013Z-spec-auto-complete-163",
  "childRunId": "2026-06-30T165657800Z-issue-implement-165",
  "ticket": { "number": 165 },
  "localRunRecord": "/repo/.pullops/runs/2026-06-30T165657800Z-issue-implement-165",
  "heartbeatAt": "2026-06-30T17:10:00.000Z",
  "leaseExpiresAt": "2026-06-30T17:18:00.000Z",
  "heartbeatCount": 12,
  "heartbeatSummary": "run focused tests",
  "completedNonHeartbeatStepsSinceHeartbeat": 0
}
```

The parent sink validates the bearer token, expected parent run id, active child run id or active ticket, and monotonic heartbeat count before emitting `child.heartbeat`. Invalid sink requests are rejected and do not become PullOps Progress Events.

Long-running local workers report PullOps Heartbeats through a deterministic PullOps Heartbeat Command using the current run state path and a per-run token passed in the runner environment. The heartbeat is produced by the active worker, not invented by an outer process waiting on it, and it is distinct from human-facing PullOps Progress Events.

PullOps Leases are intervention guards, not locks. A supervisor must not infer a worker is stuck from lack of visible progress: it waits while the lease is active, reconciles PullOps Liveness Signals after lease expiry, and records a PullOps Stall Classification before stopping or retrying work it owns. In the nested local model, reliable live liveness is a Child Heartbeat Event delivered through the parent event sink; durable child `state.json` inspection is reserved for reconciliation after stream interruption, sink loss, or lease expiry. Log, git diff, GitHub, and CI observations are not required liveness signals.

PullOps Go should report milestones immediately and give humans a compact healthy-run update every 5-10 minutes, but it must not show every heartbeat. The manager loop should behave as observe, reconcile, start the next eligible operation, and wait.
