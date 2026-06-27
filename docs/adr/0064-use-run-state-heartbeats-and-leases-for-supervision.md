# Use run state, heartbeats, and leases for supervision

PullOps Event Supervision extends ADR-0052's JSONL Progress Event stream with a mutable `state.json` in each Local Run Record. The event stream remains the semantic history and terminal summary surface, while `state.json` carries machine-only supervision state such as `status`, `phase`, `heartbeatAt`, `leaseExpiresAt`, `lastEvent`, and `childRuns`.

Long-running local workers report PullOps Heartbeats through a deterministic PullOps Heartbeat Command using the current run state path and a per-run token passed in the runner environment. The heartbeat is produced by the active worker, not invented by an outer process waiting on it, and it is distinct from human-facing PullOps Progress Events.

PullOps Leases are intervention guards, not locks. A supervisor must not infer a worker is stuck from lack of visible progress: it waits while the lease is active, reconciles v1 PullOps Liveness Signals after lease expiry, and records a PullOps Stall Classification before stopping or retrying work it owns. In the first local model, reliable liveness is an advanced heartbeat or a changed child run set; log, git diff, GitHub, and CI observations are not required liveness signals.

PullOps Go should report milestones immediately and give humans a compact healthy-run update every 5-10 minutes, but it must not show every heartbeat. The manager loop should behave as observe, reconcile, start the next eligible operation, and wait.
