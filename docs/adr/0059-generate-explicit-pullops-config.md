# Generate explicit PullOps Config

PullOps Init creates a minimal `pullops.config.js` that default-exports a typed PullOps Config object with an explicit GitHub Issue Store selection. The generated file uses `/** @type {import("@pull-ops/cli/types.js").PullOpsConfig} */` so JavaScript target repositories get editor feedback without requiring TypeScript configuration, and it uses the domain term `PullOpsConfig` rather than introducing a separate CLI-specific config name.
