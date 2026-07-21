# Require ES modules for PullOps Config

PullOps supports Target Repositories whose root `package.json` declares `"type": "module"` and generates `pullops.config.js` as an ES module. PullOps Init rejects other package types instead of changing the established config filename to `.mjs`; this supersedes ADR-0074 and keeps the PullOps Config contract consistent with the project's JavaScript file convention.
