# Use native sub-issues for PRD child identity

PullOps treats GitHub's native sub-issue relationship as the single source of truth for Parent Issue and Child Issue identity. Body text such as `Part of #<prd>` may remain in Child Issue PR bodies as human-readable traceability, but PRD Child Coordination, Child Issue PR validation, and Umbrella PR readiness must not discover or authorize child work from body references because those references can drift from GitHub's issue graph.
