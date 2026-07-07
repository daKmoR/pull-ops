import type { WorkflowOperationConfigKey } from '../operations/types.js';
import type { RunnerAdapter } from '../runner/types.js';

export type ModelTier = 'high' | 'mid' | 'low';
export type IssueStoreProvider = 'github';

export interface RunnerConfig {
  adapter: RunnerAdapter;
  command: string;
  models: Record<ModelTier, string>;
  argsTemplate?: string[];
}

export interface IssueStoreConfig {
  provider?: IssueStoreProvider;
}

export interface OperationConfig {
  modelTier: ModelTier;
}

export interface ReviewOperationConfig extends OperationConfig {
  escalationModelTier: ModelTier;
  humanFeedbackResponseModelTier: ModelTier;
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
      : Key extends 'prReview' | 'prAddressReview'
        ? ReviewOperationConfig
        : OperationConfig;
};

export interface RunBudgetConfig {
  maxUsedTokens: number;
  maxDurationMs: number;
}

export interface PullOpsConfig {
  baseBranch: string;
  branchPrefix: string;
  issueStore: IssueStoreConfig;
  runner: RunnerConfig;
  runBudget: RunBudgetConfig;
  operations: OperationsConfig;
}

export interface UserIssueStoreConfig {
  provider?: unknown;
}

export interface UserRunnerConfig {
  adapter?: unknown;
  command?: unknown;
  models?: unknown;
  argsTemplate?: unknown;
}

export interface UserOperationConfig {
  modelTier?: unknown;
}

export interface UserReviewOperationConfig extends UserOperationConfig {
  escalationModelTier?: unknown;
  humanFeedbackResponseModelTier?: unknown;
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
      : Key extends 'prReview' | 'prAddressReview'
        ? UserReviewOperationConfig
        : UserOperationConfig;
}>;

export interface UserRunBudgetConfig {
  maxUsedTokens?: unknown;
  maxDurationMs?: unknown;
}

export interface UserPullOpsConfig {
  baseBranch?: unknown;
  branchPrefix?: unknown;
  issueStore?: UserIssueStoreConfig | unknown;
  runner?: UserRunnerConfig | unknown;
  runBudget?: UserRunBudgetConfig | unknown;
  operations?: UserOperationsConfig | unknown;
}
