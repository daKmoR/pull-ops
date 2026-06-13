export type WorkflowTarget = 'issue' | 'pr';

export type WorkflowTargetOption = 'issue' | 'pr';

export type WorkflowOperationConfigKey =
  | 'preparePrd'
  | 'implementIssue'
  | 'coordinatePrd'
  | 'reviewPr'
  | 'addressReview'
  | 'fixCi'
  | 'updateBranch'
  | 'resolveConflicts'
  | 'prepareMerge'
  | 'closeChildIssue';

export interface WorkflowOperation {
  name: string;
  target: WorkflowTarget;
  option: WorkflowTargetOption;
  configKey: WorkflowOperationConfigKey;
}
