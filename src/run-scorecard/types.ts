export interface RunScorecardStatusCounts {
  accepted: number;
  blocked: number;
  refused: number;
  failed: number;
  running: number;
  waiting: number;
}

export interface RunScorecardDurationSummary {
  knownRuns: number;
  totalMs: number;
  averageMs?: number;
}

export interface RunScorecardContextUsageSummary {
  knownRuns: number;
  totalUsedTokens: number;
}

export interface RunScorecardGroup {
  runs: number;
  terminalRuns: number;
  statuses: RunScorecardStatusCounts;
  acceptedRate?: number;
  blockedRate?: number;
  duration: RunScorecardDurationSummary;
  contextUsage: RunScorecardContextUsageSummary;
}

export interface RunScorecardModelTierGroup extends RunScorecardGroup {
  modelTier: string;
}

export interface RunScorecardOperationGroup extends RunScorecardGroup {
  operationReference: string;
  modelTiers: RunScorecardModelTierGroup[];
}

export interface RunScorecardSkippedRunRecord {
  runId: string;
  reason: string;
}

export interface RunScorecard {
  schemaVersion: 1;
  runsDirectory: string;
  totals: RunScorecardGroup;
  operations: RunScorecardOperationGroup[];
  skippedRunRecords: RunScorecardSkippedRunRecord[];
}
