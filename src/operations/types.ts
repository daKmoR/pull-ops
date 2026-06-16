export type WorkflowTarget = 'issue' | 'pr';

export type WorkflowTargetOption = 'issue' | 'pr';

export type WorkflowOperationConfigKey =
  | 'prdPrepare'
  | 'issueImplement'
  | 'prdAutoAdvance'
  | 'prdAutoComplete'
  | 'prReview'
  | 'prAddressReview'
  | 'prFixCi'
  | 'prUpdateBranch'
  | 'prResolveConflicts'
  | 'prFinalize'
  | 'prCloseChildIssue';

export interface WorkflowOperation {
  name: string;
  target: WorkflowTarget;
  option: WorkflowTargetOption;
  configKey: WorkflowOperationConfigKey;
}
