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

export type ImplementIssueOutput = ImplementedIssueOutput | BlockedIssueOutput;

export type ImplementIssueOutputValidationResult =
  | { valid: true; value: ImplementIssueOutput }
  | { valid: false; reason: string };
