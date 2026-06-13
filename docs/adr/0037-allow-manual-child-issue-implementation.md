# Allow manual child issue implementation

PullOps allows a maintainer to label a Child Issue with `pullops:implement` directly, even when the Parent Issue is not labeled. Parent setup now belongs to `pullops:prepare`, future automatic orchestration belongs to reserved `pullops:coordinate`, and direct Child Issue labeling remains the manual selection path for choosing a specific issue and order without blocking on parent-level automation.
