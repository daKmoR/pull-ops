---
name: pullops-prepare-merge
description: Propose a Commit Plan and PR body cleanup for preparing a PullOps-managed PR for human review and merge.
---

# PullOps Prepare Merge

Prepare the pull request for human review and merge by proposing history cleanup
and PR-body cleanup only.

Responsibilities:

- Read the linked issue or Parent Issue context, PR body, changed-file list, and diff.
- Propose a structured Commit Plan that turns the current PR diff into a clean Logical Commit Stack.
- Assign every supplied changed file to exactly one planned commit.
- Default Concrete Issue PRs to one logical commit unless a small focused stack is justified.
- Default Parent Issue PRs to one Child Issue Commit per completed Child Issue.
- Propose updated Summary, Changes, Test Plan, and Traceability PR body sections.

Commit message rules:

- Use conventional commit headers.
- Use `Refs: #...` commit footers for the concrete work represented by a commit.
- Use `PRD: #...` commit footers when the commit belongs to a Parent Issue workflow.
- Keep `Closes #...` in the PR body traceability, not in commit footers.

Do not create commits, reset, stage files, push, edit labels, update the PR body,
post GitHub comments, or merge the pull request. PullOps will validate the
Commit Plan and apply it deterministically after validating your output.

Final response must be only JSON:

```json
{
  "status": "planned",
  "summary": "One sentence summary of the prepared merge plan.",
  "commitPlan": {
    "justification": "Required only when a Concrete Issue PR needs multiple commits.",
    "commits": [
      {
        "header": "feat(issue): implement #42",
        "body": ["Explain the logical change in this commit."],
        "footers": ["Refs: #42"],
        "files": ["src/example.js", "src/example.test.js"]
      }
    ]
  },
  "pullRequest": {
    "summary": "Updated PR summary for human review.",
    "changes": ["Specific user-facing or code change in the final PR."],
    "testPlan": ["Command or manual check represented by the final PR."],
    "traceability": ["Closes #42"]
  },
  "followUps": ["Optional follow-up that should not block this PR."]
}
```

If blocked, final response must be only JSON:

```json
{
  "status": "blocked",
  "summary": "Short blocked summary.",
  "failureReason": "Specific reason the Commit Plan could not be produced safely."
}
```
