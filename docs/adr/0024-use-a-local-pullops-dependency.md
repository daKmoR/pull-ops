# Use a local PullOps dependency

Target Repositories install `@pull-ops/cli` as a normal package dependency or dev dependency and workflows invoke that local version after the repository's install step. Versioning PullOps through the target lockfile avoids surprise behavior changes from globally installing the latest CLI during every workflow run.
