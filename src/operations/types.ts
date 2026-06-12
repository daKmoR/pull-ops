export type WorkflowTarget = 'issue' | 'pr';

export type WorkflowTargetOption = 'issue' | 'pr';

export type WorkflowOperationConfigKey =
  | 'implementIssue'
  | 'implementPrd'
  | 'reviewPr'
  | 'addressReview'
  | 'fixCi'
  | 'updateBranch'
  | 'resolveConflicts'
  | 'prepareMerge';

export interface WorkflowOperation {
  name: string;
  target: WorkflowTarget;
  option: WorkflowTargetOption;
  configKey: WorkflowOperationConfigKey;
}
