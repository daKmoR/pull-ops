export interface FailedCheck {
  id: string;
  checkName: string;
  workflowName?: string;
  state?: string;
  conclusion?: string;
  bucket?: string;
  detailsUrl?: string;
}
