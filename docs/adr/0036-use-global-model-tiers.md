# Use global model tiers

PullOps v1 uses global high, mid, and low Model Tiers rather than per-operation concrete model overrides. Operations select a tier, and the runner config maps all tiers to concrete Codex models; if a repository overrides the model map, it must provide every tier so operation defaults remain valid.
