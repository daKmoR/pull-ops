# Pin generated GitHub Actions

The Workflow Kit generator replaces every third-party GitHub Action version tag with a reviewed full commit SHA while retaining the human-readable release tag as a YAML comment. Generated workflows receive repository and model credentials, so immutable action identities are part of PullOps supply-chain safety. A generator-level contract test rejects newly introduced floating action references.
