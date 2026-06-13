import type { ModelTier, OperationConfig } from './types.js';

export type { ModelTier, OperationConfig } from './types.js';

export interface RunnerConfig {
  provider: 'codex';
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
