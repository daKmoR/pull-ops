import type {
  IssueStoreConfig,
  ModelTier,
  OperationConfig,
  PrFinalizeOperationConfig,
  PrResolveConflictsOperationConfig,
} from './types.js';
import type { RunnerAdapter } from '../runner/types.js';

export type {
  IssueStoreConfig,
  IssueStoreProvider,
  ModelTier,
  OperationConfig,
  PrFinalizeOperationConfig,
  PrResolveConflictsOperationConfig,
} from './types.js';
export type { RunnerAdapter } from '../runner/types.js';

export interface RunnerConfig {
  adapter: RunnerAdapter;
  command: string;
  models: Record<ModelTier, string>;
}

export interface PullOpsConfig {
  baseBranch: string;
  branchPrefix: string;
  issueStore: IssueStoreConfig;
  runner: RunnerConfig;
  operations: {
    prdPrepare: OperationConfig;
    issueImplement: OperationConfig;
    prdAutoAdvance: OperationConfig;
    prdAutoComplete: OperationConfig;
    prReview: OperationConfig;
    prAddressReview: OperationConfig;
    prFixCi: OperationConfig;
    prUpdateBranch: OperationConfig;
    prResolveConflicts: PrResolveConflictsOperationConfig;
    prFinalize: PrFinalizeOperationConfig;
    prCloseChildIssue: OperationConfig;
  };
}
