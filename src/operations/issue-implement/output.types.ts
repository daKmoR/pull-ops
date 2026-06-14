export interface ImplementedIssueOutput {
  status: 'implemented';
  summary: string;
  changes: string[];
  testPlan: string[];
  followUps: string[];
}

export interface BlockedIssueOutput {
  status: 'blocked';
  summary: string;
  failureReason: string;
}

export type IssueImplementOutput = ImplementedIssueOutput | BlockedIssueOutput;

export type IssueImplementOutputValidationResult =
  | { valid: true; value: IssueImplementOutput }
  | { valid: false; reason: string };
