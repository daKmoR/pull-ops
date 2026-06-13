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
    preparePrd: OperationConfig;
    implementIssue: OperationConfig;
    coordinatePrd: OperationConfig;
    reviewPr: OperationConfig;
    addressReview: OperationConfig;
    fixCi: OperationConfig;
    updateBranch: OperationConfig;
    resolveConflicts: OperationConfig;
    prepareMerge: OperationConfig;
  };
}
