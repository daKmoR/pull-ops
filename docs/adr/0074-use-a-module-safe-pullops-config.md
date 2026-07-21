---
status: superseded by ADR-0077
---

# Use a module-safe PullOps Config

PullOps Init creates `pullops.config.mjs` so the generated ESM configuration loads in both CommonJS and ESM Target Repositories. PullOps continues to discover and load an existing `pullops.config.js` for backward compatibility, but new repositories receive only the module-safe filename. This supersedes the generated filename portions of ADR-0055, ADR-0059, and ADR-0063.
