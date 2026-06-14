export type CheckFailureClassification =
  | 'formatting'
  | 'lint'
  | 'type'
  | 'test'
  | 'build'
  | 'environment'
  | 'flaky'
  | 'secret';

export interface ClassifiedCheckFailure {
  id: string;
  checkName: string;
  workflowName?: string;
  state?: string;
  conclusion?: string;
  bucket?: string;
  detailsUrl?: string;
  classification: CheckFailureClassification;
  actionable: boolean;
  reason: string;
}
