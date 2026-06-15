# Use child issue commits for parent history

PullOps parent/child workflows implement each Child Issue through a Child Issue PR targeting the Parent Issue's Umbrella Branch. Once Child Issue PRs are integrated into the Umbrella Branch, the umbrella history should preserve one Child Issue Commit per merged Child Issue PR by default, so the final parent history remains traceable to the child work instead of collapsing the whole Parent Issue into one commit.
