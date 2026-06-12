# Make update-branch a non-AI rebase

The `pullops-update-branch` operation is deterministic branch maintenance, not an AI task. It rebases a Same-Repository PR branch onto the configured base branch, pushes with force-with-lease when clean, and hands off to conflict resolution when rebase conflicts occur.
