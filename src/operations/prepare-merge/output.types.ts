export interface PlannedCommit {
  header: string;
  body: string[];
  footers: string[];
  files: string[];
}

export interface CommitPlan {
  justification?: string;
  commits: PlannedCommit[];
}

export interface PreparedPullRequestSections {
  summary: string;
  changes: string[];
  testPlan: string[];
  traceability: string[];
}

export interface PlannedPrepareMergeOutput {
  status: 'planned';
  summary: string;
  commitPlan: CommitPlan;
  pullRequest: PreparedPullRequestSections;
  followUps: string[];
}

export interface BlockedPrepareMergeOutput {
  status: 'blocked';
  summary: string;
  failureReason: string;
}

export type PrepareMergeOutput = PlannedPrepareMergeOutput | BlockedPrepareMergeOutput;

export type PrepareMergeOutputValidationResult =
  | { valid: true; value: PrepareMergeOutput }
  | { valid: false; reason: string };
