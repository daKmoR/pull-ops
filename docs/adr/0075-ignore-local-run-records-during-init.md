# Ignore Local Run Records during Init

PullOps Init makes `.pullops/runs/` an idempotent git ignore rule while preserving Target Repository-owned `.gitignore` content. Local Run Records can contain prompts, patches, paths, and model output, so keeping them out of commits is setup safety rather than optional doctor guidance. The Install Manifest does not own `.gitignore`.
