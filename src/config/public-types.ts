import type { ModelTier, OperationConfig } from './types.js';
import type { RunnerAdapter } from '../runner/types.js';

export type { ModelTier, OperationConfig } from './types.js';
export type { RunnerAdapter } from '../runner/types.js';

export interface RunnerConfig {
  adapter: RunnerAdapter;
  command: string;
  models: Record<ModelTier, string>;
}

export interface PullOpsConfig {
  baseBranch: string;
  branchPrefix: string;
  runner: RunnerConfig;
  operations: {
    prdPrepare: OperationConfig;
    issueImplement: OperationConfig;
    prdCoordinate: OperationConfig;
    prReview: OperationConfig;
    prAddressReview: OperationConfig;
    prFixCi: OperationConfig;
    prUpdateBranch: OperationConfig;
    prResolveConflicts: OperationConfig;
    prPrepareMerge: OperationConfig;
    prCloseChildIssue: OperationConfig;
  };
}
