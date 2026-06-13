# Split parent prepare, issue implement, and future coordinate

PullOps separates the overloaded `pullops:implement` behavior into `pullops:prd:prepare` for Parent Issue umbrella branch and draft PR setup, `pullops:issue:implement` for exactly one Concrete Issue, and reserved `pullops:prd:coordinate` for future automatic parent/child orchestration. This staged split keeps the current manual workflow explicit while preserving the later automation path without making the current implementation coordinate Child Issues.

ADR-0039 generalizes this split into the `pullops:<target-kind>:<operation>` Operation Label grammar.

ADR-0041 specifies that a manually selected Child Issue is implemented through its own Child Issue PR targeting the PRD Umbrella Branch, not by committing directly to the umbrella branch.
