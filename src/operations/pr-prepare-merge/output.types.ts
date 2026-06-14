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

export interface PlannedPrPrepareMergeOutput {
  status: 'planned';
  summary: string;
  commitPlan: CommitPlan;
  pullRequest: PreparedPullRequestSections;
  followUps: string[];
}

export interface BlockedPrPrepareMergeOutput {
  status: 'blocked';
  summary: string;
  failureReason: string;
}

export type PrPrepareMergeOutput = PlannedPrPrepareMergeOutput | BlockedPrPrepareMergeOutput;

export type PrPrepareMergeOutputValidationResult =
  | { valid: true; value: PrPrepareMergeOutput }
  | { valid: false; reason: string };
