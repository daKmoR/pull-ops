# Use child issue commits for parent history

PullOps parent/child workflows should preserve one Child Issue Commit per merged Child Issue PR by default once child work is integrated into the umbrella branch. Prepare-merge may fold review and CI noise into the relevant Child Issue commit, but should not squash an entire parent issue into one commit unless the parent scope is genuinely tiny.

ADR-0041 changes the integration unit to Child Issue PRs targeting the Umbrella Branch; this ADR now applies to the resulting Umbrella Branch history, not to direct child commits on the PRD branch.
