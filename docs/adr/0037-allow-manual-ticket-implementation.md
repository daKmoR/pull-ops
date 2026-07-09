# Allow manual ticket implementation

PullOps allows a maintainer to label a Ticket with `pullops:issue:implement` directly, even when the Parent Issue is not labeled. Parent setup belongs to `pullops:spec:prepare`, automated orchestration belongs to `pullops:spec:auto-advance` and `pullops:spec:auto-complete`, and direct Ticket labeling remains the manual selection path for choosing a specific issue and order without blocking on parent-level automation. Each selected Ticket is implemented through its own Ticket PR targeting the Parent Issue's Umbrella Branch.
