# Validate structured output for every operation

Every PullOps Workflow-Facing Command should have a typed Operation Output contract, validated before the CLI mutates GitHub state. PullOps should follow the scratch review runner pattern: prompt the agent for a final structured JSON block, validate it with schemas, normalize unsafe or aliased fields, write workflow-consumable artifacts to `OUTPUT_DIR`, and treat stdout as logs rather than machine-readable output.
