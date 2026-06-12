# Install PullOps skills flat

PullOps installs its repo-local PullOps Skills directly under `.agents/skills/` with a `pullops-` prefix, such as `.agents/skills/pullops-implement-issue/SKILL.md`. Nested skill directories are cleaner for ownership, but flat installation is more compatible with tools that only discover one skill directory level.
