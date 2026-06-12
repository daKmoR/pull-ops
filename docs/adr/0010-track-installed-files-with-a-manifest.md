# Track installed files with a manifest

PullOps should track generated Workflow Kit files, including workflows and PullOps Skills, in an Install Manifest. Init can use recorded content hashes to safely re-run installs, update untouched generated files, and detect user-edited skills or workflows that need an explicit merge or force decision later.
