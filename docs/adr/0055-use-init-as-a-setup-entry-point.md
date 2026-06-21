# Use Init as a setup entry point

PullOps Init installs only the minimum files needed for agent-guided setup: `pullops.config.js`, `.pullops/install-manifest.json`, and `.agents/skills/pullops-setup/SKILL.md`. Full Workflow Kit installation moves to deterministic `pullops setup *` commands invoked by the PullOps Setup Skill, because repo-specific setup needs AI-guided judgment while PullOps-owned artifacts still need deterministic, idempotent generation.

This narrows the earlier ADR-0009 wording that said Init reconciles the whole Workflow Kit. Init remains idempotent and non-destructive, but complete Workflow Kit reconciliation belongs to namespaced PullOps Setup Commands.
