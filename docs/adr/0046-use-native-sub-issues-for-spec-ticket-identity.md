# Use native sub-issues for Spec ticket identity

PullOps treats GitHub's native sub-issue relationship as the single source of truth for Parent Issue and Ticket identity. Body text such as `Part of #<spec>` may remain in Ticket PR bodies as human-readable traceability, but Spec Ticket Coordination, Ticket PR validation, and Umbrella PR readiness must not discover or authorize ticket work from body references because those references can drift from GitHub's issue graph.
