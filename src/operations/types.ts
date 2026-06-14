export type WorkflowTarget = 'issue' | 'pr';

export type WorkflowTargetOption = 'issue' | 'pr';

export type WorkflowOperationConfigKey =
  | 'prdPrepare'
  | 'issueImplement'
  | 'prdCoordinate'
  | 'prReview'
  | 'prAddressReview'
  | 'prFixCi'
  | 'prUpdateBranch'
  | 'prResolveConflicts'
  | 'prPrepareMerge'
  | 'prCloseChildIssue';

export interface WorkflowOperation {
  name: string;
  target: WorkflowTarget;
  option: WorkflowTargetOption;
  configKey: WorkflowOperationConfigKey;
}
