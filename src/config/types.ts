import type { WorkflowOperationConfigKey } from '../operations/types.js';

export type ModelTier = 'high' | 'mid' | 'low';

export interface RunnerConfig {
  provider: string;
  command: string;
  models: Record<ModelTier, string>;
}

export interface OperationConfig {
  modelTier: ModelTier;
}

export type OperationsConfig = Record<WorkflowOperationConfigKey, OperationConfig>;

export interface PullOpsConfig {
  baseBranch: string;
  branchPrefix: string;
  runner: RunnerConfig;
  operations: OperationsConfig;
}

export interface UserRunnerConfig {
  provider?: unknown;
  command?: unknown;
  models?: unknown;
}

export interface UserOperationConfig {
  modelTier?: unknown;
}

export interface UserPullOpsConfig {
  baseBranch?: unknown;
  branchPrefix?: unknown;
  runner?: UserRunnerConfig | unknown;
  operations?: Partial<Record<WorkflowOperationConfigKey, UserOperationConfig>> | unknown;
}
