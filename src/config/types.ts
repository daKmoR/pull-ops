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

export interface PrResolveConflictsOperationConfig extends OperationConfig {
  maxConflictResolutionPasses: number;
}

export type OperationsConfig = {
  [Key in WorkflowOperationConfigKey]: Key extends 'prFinalize'
    ? PrFinalizeOperationConfig
    : Key extends 'prResolveConflicts'
      ? PrResolveConflictsOperationConfig
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

export interface UserPrResolveConflictsOperationConfig extends UserOperationConfig {
  maxConflictResolutionPasses?: unknown;
}

export type UserOperationsConfig = Partial<{
  [Key in WorkflowOperationConfigKey]: Key extends 'prFinalize'
    ? UserPrFinalizeOperationConfig
    : Key extends 'prResolveConflicts'
      ? UserPrResolveConflictsOperationConfig
      : UserOperationConfig;
}>;

export interface UserPullOpsConfig {
  baseBranch?: unknown;
  branchPrefix?: unknown;
  runner?: UserRunnerConfig | unknown;
  operations?: UserOperationsConfig | unknown;
}
