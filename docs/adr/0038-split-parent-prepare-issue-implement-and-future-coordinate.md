# Split parent prepare, issue implement, and Spec automation modes

PullOps separates Parent Issue preparation, Concrete Issue implementation, and parent/ticket orchestration into distinct operations: `pullops:spec:prepare` sets up the Parent Issue's umbrella branch and draft Umbrella PR, `pullops:issue:implement` implements exactly one Concrete Issue, and `pullops:spec:auto-advance` plus `pullops:spec:auto-complete` are the automatic orchestration paths. This staged split keeps the manual Ticket workflow explicit while making Spec automation opt-in through durable mode labels.

ADR-0044 supersedes the reserved coordinate path with explicit `spec-auto-advance` and `spec-auto-complete` automation modes.
