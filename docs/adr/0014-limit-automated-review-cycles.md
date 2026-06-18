# Limit automated review cycles

PullOps may automatically loop pr-review and pr-address-review operations, but the loop must stop at a configured maximum, defaulting to three Review Cycles. Because only an approved pr-review records the reviewed tree needed by pr-finalize, PullOps should not spend the final available cycle on address-review work that cannot be followed by another automated review. The current cycle count should be recorded in a visible PR State Marker so humans can see how much automated review work happened before the PR reached them.
