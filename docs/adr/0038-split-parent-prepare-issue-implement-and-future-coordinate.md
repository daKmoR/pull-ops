# Split parent prepare, issue implement, and future coordinate

PullOps separates the overloaded `pullops:implement` behavior into `pullops:prepare` for Parent Issue umbrella branch and draft PR setup, `pullops:implement` for exactly one Concrete Issue, and reserved `pullops:coordinate` for future automatic parent/child orchestration. This staged split keeps the current manual workflow explicit while preserving the later automation path without making the current implementation coordinate Child Issues.
