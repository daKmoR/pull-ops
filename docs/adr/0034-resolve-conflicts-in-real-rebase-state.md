# Resolve conflicts in real rebase state

The `pullops-resolve-conflicts` operation works inside Git's actual conflicted rebase state. The CLI starts the rebase, captures conflict context, invokes the AI runner to edit conflicted files and run checks, continues the rebase, repeats within a budget if more conflicts appear, then pushes with force-with-lease and sends the PR back through review.
