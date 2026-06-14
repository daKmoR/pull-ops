# Organize runner code by operation

PullOps runner code lives in operation-owned package directories such as `src/operations/pr-review/`, with each Operation Module owning orchestration code, prompts, extraction instructions, and output schemas. Repo-local PullOps Skills remain installed Workflow Kit content, while executable runner logic remains versioned in the CLI package.
