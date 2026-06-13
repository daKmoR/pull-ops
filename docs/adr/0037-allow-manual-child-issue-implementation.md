# Allow manual child issue implementation

PullOps allows a maintainer to label a Child Issue with `pullops:issue:implement` directly, even when the Parent Issue is not labeled. Parent setup now belongs to `pullops:prd:prepare`, future automatic orchestration belongs to reserved `pullops:prd:coordinate`, and direct Child Issue labeling remains the manual selection path for choosing a specific issue and order without blocking on parent-level automation.

ADR-0041 keeps this manual selection path but implements each selected Child Issue through its own Child Issue PR targeting the Parent Issue's Umbrella Branch.
