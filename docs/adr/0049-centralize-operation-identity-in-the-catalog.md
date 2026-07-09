# Centralize operation identity in the catalog

PullOps operation identity facts are scattered across runtime dispatch, label constants, config defaults, package scripts, and dogfood workflow files. PullOps will centralize canonical facts for the fixed PullOps Operation set in the Operation Catalog, including operation names, labels, targets, workflow-facing identity, default operation settings, supported runner adapters, and runtime handlers. Operation Modules continue to own orchestration code, prompts, extraction instructions, and Operation Output schemas per ADR-0027; the catalog imports operation-owned handlers instead of asking Operation Modules to export descriptors, so the catalog owns cross-operation identity and dispatch facts rather than becoming a plugin registry or Workflow Kit generator.

The Operation Catalog is the deep module for operation identity facts only. It owns the fixed PullOps Operation entries, including Operation Name, target kind, workflow-facing command shape, config key, default operation settings, supported Runner Adapters and lifecycle phases, runtime handler references, Operation Label Reference when one exists, Operation Label name and description, workflow file identity, and package script identity.

The catalog does not own operation-to-operation routing. Managed PR transitions, Spec Ticket Coordination, and other workflow state machines remain responsible for deciding that one Operation should lead to another, such as `pr-finalize` routing back to `pr-review` or `pr-update-branch` handing off to `pr-resolve-conflicts`. Those modules may consume catalog-owned operation facts, but the routing policy stays local to the module that owns the workflow state.

The catalog does not render GitHub Actions workflows. Workflow YAML templates stay in the Workflow Kit rendering module because each workflow still has operation-specific behavior. The renderer consumes catalog-owned workflow identity facts such as operation names, target inputs, dispatch labels, and workflow filenames.

Operation Labels are derived from dispatchable catalog entries. PullOps Status Labels, including `pullops:human-required`, stay separate because they are not Operation identity. Workflow-facing operations that have no Operation Label Reference, such as `pr-close-ticket`, are still catalog entries with no dispatchable label reference.

Callers should use purpose-specific catalog queries rather than raw exported arrays or label maps. PullOps will migrate callers directly to the catalog interface instead of keeping compatibility exports for the old parallel lists.

PullOps Skill names are not catalog facts in this decision. They remain installed Workflow Kit content and Operation Module prompt behavior unless a concrete caller later needs catalog-owned lookup.
