# Use sub-issue commits for PRD history

PullOps PRD implementation should create a final Logical Commit Stack with one Sub-Issue Commit per completed sub-issue by default. Prepare-merge may fold review and CI noise into the relevant sub-issue commit, but should not squash an entire PRD into one commit unless the PRD is genuinely tiny.
