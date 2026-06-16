# Allow manual child issue implementation

PullOps allows a maintainer to label a Child Issue with `pullops:issue:implement` directly, even when the Parent Issue is not labeled. Parent setup belongs to `pullops:prd:prepare`, automated orchestration belongs to `pullops:prd:auto-advance` and `pullops:prd:auto-complete`, and direct Child Issue labeling remains the manual selection path for choosing a specific issue and order without blocking on parent-level automation. Each selected Child Issue is implemented through its own Child Issue PR targeting the Parent Issue's Umbrella Branch.
