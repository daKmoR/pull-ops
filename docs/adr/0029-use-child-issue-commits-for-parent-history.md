# Use child issue commits for parent history

PullOps parent/child workflows should preserve one Child Issue Commit per completed Child Issue by default once child work is integrated into the umbrella branch. Prepare-merge may fold review and CI noise into the relevant Child Issue commit, but should not squash an entire parent issue into one commit unless the parent scope is genuinely tiny.
