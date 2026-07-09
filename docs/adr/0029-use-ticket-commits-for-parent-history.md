# Use ticket commits for parent history

PullOps parent/ticket workflows implement each Ticket through a Ticket PR targeting the Parent Issue's Umbrella Branch. Once Ticket PRs are integrated into the Umbrella Branch, the umbrella history should preserve one Ticket Commit per merged Ticket PR by default, so the final parent history remains traceable to the ticket work instead of collapsing the whole Parent Issue into one commit.
