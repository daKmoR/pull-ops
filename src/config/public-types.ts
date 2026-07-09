import type { IssueStoreConfig, ModelTier } from './types.js';
import type { RunnerAdapter } from '../runner/types.js';

export type { IssueStoreConfig, IssueStoreProvider, ModelTier } from './types.js';
export type { RunnerAdapter } from '../runner/types.js';

export interface RunnerConfig {
  adapter?: RunnerAdapter;
  command?: string;
  models?: Record<ModelTier, string>;
  argsTemplate?: string[];
}

export interface OperationConfig {
  modelTier?: ModelTier;
}

export interface ReviewOperationConfig extends OperationConfig {
  escalationModelTier?: ModelTier;
  humanFeedbackResponseModelTier?: ModelTier;
}

export interface PrFinalizeOperationConfig extends OperationConfig {
  aiHistoryCleanup?: boolean;
}

export interface PrResolveConflictsOperationConfig extends OperationConfig {
  maxConflictResolutionPasses?: number;
}

export interface RunBudgetConfig {
  maxUsedTokens?: number;
  maxDurationMs?: number;
}

export interface PullOpsConfig {
  baseBranch?: string;
  branchPrefix?: string;
  issueStore?: IssueStoreConfig;
  runner?: RunnerConfig;
  runBudget?: RunBudgetConfig;
  operations?: Partial<{
    specPrepare: OperationConfig;
    issueImplement: OperationConfig;
    specAutoAdvance: OperationConfig;
    specAutoComplete: OperationConfig;
    prReview: ReviewOperationConfig;
    prAddressReview: ReviewOperationConfig;
    prFixCi: OperationConfig;
    prUpdateBranch: OperationConfig;
    prResolveConflicts: PrResolveConflictsOperationConfig;
    prFinalize: PrFinalizeOperationConfig;
    prCloseTicket: OperationConfig;
  }>;
}
