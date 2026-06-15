---
name: pullops-pr-finalize
description: Propose history grouping and commit messages only for ambiguous PullOps PR Finalize histories.
---

# PullOps PR Finalize

Plan history cleanup for an ambiguous PullOps-managed PR only. PullOps invokes
this skill as a fallback after deterministic PR Finalize cannot safely group
history itself.

Responsibilities:

- Read the Parent Issue context, closed native Child Issues, PR body, changed-file list, and current commit history.
- Propose a structured Commit Plan that groups the supplied changed files into the final Logical Commit Stack.
- Assign every supplied changed file to exactly one planned commit.
- Do not include files that were not supplied.
- Prefer one Child Issue Commit per closed native Child Issue represented by the files.
- Include parent-level commits only for explicit PRD-level files.

Commit message rules:

- Use conventional commit headers.
- Use `Refs: #<child>` and `PRD: #<parent>` footers for Child Issue work.
- Use `Refs: #<parent>` footers for explicit parent-level PRD work.
- Do not use GitHub closing keywords in commit footers.

Do not edit files, run commands, create commits, reset, stage files, push, edit
labels, update PR bodies, change PR references, touch review state, touch
checks, change draft state, change merge state, post GitHub comments, or merge
the pull request. PullOps validates the Commit Plan, applies the rewrite
deterministically, pushes with force-with-lease, and verifies the final tree
still matches the reviewed tree.

Final response must be only JSON:

```json
{
  "status": "planned",
  "summary": "One sentence summary of the history grouping plan.",
  "commitPlan": {
    "justification": "Required when grouping is not one commit per closed Child Issue.",
    "commits": [
      {
        "header": "feat(issue): implement #42",
        "body": ["Explain the logical change in this commit."],
        "footers": ["Refs: #42"],
        "files": ["src/example.js", "src/example.test.js"]
      }
    ]
  },
  "followUps": ["Optional follow-up that should not block this PR."]
}
```

If blocked, final response must be only JSON:

```json
{
  "status": "blocked",
  "summary": "Short blocked summary.",
  "failureReason": "Specific reason the history grouping plan could not be produced safely."
}
```
