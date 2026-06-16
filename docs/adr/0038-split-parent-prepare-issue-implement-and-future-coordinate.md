# Split parent prepare, issue implement, and PRD automation modes

PullOps separates Parent Issue preparation, Concrete Issue implementation, and parent/child orchestration into distinct operations: `pullops:prd:prepare` sets up the Parent Issue's umbrella branch and draft Umbrella PR, `pullops:issue:implement` implements exactly one Concrete Issue, and `pullops:prd:auto-advance` plus `pullops:prd:auto-complete` are the automatic orchestration paths. This staged split keeps the manual Child Issue workflow explicit while making PRD automation opt-in through durable mode labels.

ADR-0044 supersedes the reserved coordinate path with explicit `prd-auto-advance` and `prd-auto-complete` automation modes.
