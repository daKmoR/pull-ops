export type TriageRole =
  | 'needs-triage'
  | 'needs-info'
  | 'ready-for-agent'
  | 'ready-for-human'
  | 'wontfix';

export interface NormalizedConcreteIssueRequest {
  issueNumber?: number;
  title: string;
  whatToBuild: string;
  acceptanceCriteria: string[];
  blockedBy: number[];
  triageRole?: TriageRole;
}

export interface ConcreteIssuePublicationMarker {
  schemaVersion: 1;
  provider: 'github';
  kind: 'concrete-issue';
}

export interface ConcreteIssuePublishIssue {
  number: number;
  url: string;
}

export interface ConcreteIssuePublishSuccessOutput {
  status: 'accepted';
  summary: string;
  action: 'created' | 'updated';
  issue: ConcreteIssuePublishIssue;
  warnings: string[];
  localRunRecord: string;
  triageRole?: TriageRole;
}

export interface ConcreteIssuePublishFailureOutput {
  status: 'failed';
  summary: string;
  failureReason: string;
  warnings: string[];
  localRunRecord: string;
  issue?: ConcreteIssuePublishIssue;
  action?: 'created' | 'updated';
  triageRole?: TriageRole;
}

export type ConcreteIssuePublishOutput =
  | ConcreteIssuePublishSuccessOutput
  | ConcreteIssuePublishFailureOutput;
