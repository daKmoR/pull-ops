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

export interface PlannedPrFinalizeOutput {
  status: 'planned';
  summary: string;
  commitPlan: CommitPlan;
  followUps: string[];
}

export interface BlockedPrFinalizeOutput {
  status: 'blocked';
  summary: string;
  failureReason: string;
}

export type PrFinalizeOutput = PlannedPrFinalizeOutput | BlockedPrFinalizeOutput;

export type PrFinalizeOutputValidationResult =
  | { valid: true; value: PrFinalizeOutput }
  | { valid: false; reason: string };
