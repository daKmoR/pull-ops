export interface ResolvedConflictOutput {
  status: 'resolved';
  summary: string;
  resolvedFiles: string[];
  changes: string[];
  testPlan: string[];
  followUps: string[];
}

export interface BlockedConflictOutput {
  status: 'blocked';
  summary: string;
  failureReason: string;
}

export type PrResolveConflictsOutput = ResolvedConflictOutput | BlockedConflictOutput;

export type PrResolveConflictsOutputValidationResult =
  | { valid: true; value: PrResolveConflictsOutput }
  | { valid: false; reason: string };
