# Require repository root for init and setup

PullOps Init and PullOps Setup Commands fail when run from a subdirectory of a Target Repository and instruct the user to rerun from the repository root. PullOps setup writes root-relative files such as `pullops.config.js`, `.pullops/install-manifest.json`, `.agents/skills/`, and `.github/workflows/`, so root-only execution avoids ambiguous installs in monorepos and nested package directories.
