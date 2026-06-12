# Support Codex as the v1 runner

PullOps v1 supports Codex as the default and tested AI runner, while storing the invocation as a configurable Runner Command in the Target Repository. This avoids a premature multi-provider abstraction but keeps the Workflow Kit from hard-coding runner details directly into every generated workflow.
