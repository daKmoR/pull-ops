# Limit automated review cycles

PullOps may automatically loop pr-review and pr-address-review operations, but the loop must stop at a configured maximum, defaulting to three Review Cycles. The current cycle count should be recorded in a visible PR State Marker so humans can see how much automated review work happened before the PR reached them.
