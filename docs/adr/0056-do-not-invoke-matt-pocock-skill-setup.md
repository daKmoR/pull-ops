# Do not invoke Matt Pocock skill setup

The PullOps Setup Skill should not invoke `setup-matt-pocock-skills`, even though both flows know about issue tracker docs, triage label vocabulary, and domain docs. PullOps creates missing compatible `docs/agents/*.md` files through deterministic setup commands and leaves existing docs untouched, because calling a second prompt-driven setup skill would duplicate questions, edit `AGENTS.md` or `CLAUDE.md`, and blur PullOps setup ownership.
