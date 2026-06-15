import type { WorkflowOperationConfigKey } from '../operations/types.js';
import type { RunnerAdapter } from '../runner/types.js';

export type ModelTier = 'high' | 'mid' | 'low';

export interface RunnerConfig {
  adapter: RunnerAdapter;
  command: string;
  models: Record<ModelTier, string>;
}

export interface OperationConfig {
  modelTier: ModelTier;
}

export interface PrFinalizeOperationConfig extends OperationConfig {
  aiHistoryCleanup: boolean;
}

export type OperationsConfig = {
  [Key in WorkflowOperationConfigKey]: Key extends 'prFinalize'
    ? PrFinalizeOperationConfig
    : OperationConfig;
};

export interface PullOpsConfig {
  baseBranch: string;
  branchPrefix: string;
  runner: RunnerConfig;
  operations: OperationsConfig;
}

export interface UserRunnerConfig {
  adapter?: unknown;
  command?: unknown;
  models?: unknown;
}

export interface UserOperationConfig {
  modelTier?: unknown;
}

export interface UserPrFinalizeOperationConfig extends UserOperationConfig {
  aiHistoryCleanup?: unknown;
}

export type UserOperationsConfig = Partial<{
  [Key in WorkflowOperationConfigKey]: Key extends 'prFinalize'
    ? UserPrFinalizeOperationConfig
    : UserOperationConfig;
}>;

export interface UserPullOpsConfig {
  baseBranch?: unknown;
  branchPrefix?: unknown;
  runner?: UserRunnerConfig | unknown;
  operations?: UserOperationsConfig | unknown;
}
