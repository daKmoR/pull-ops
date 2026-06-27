export type LocalRunActiveStatus = 'running' | 'waiting';

export type LocalRunTerminalStatus = 'accepted' | 'blocked' | 'refused' | 'failed';

export type LocalRunStatus = LocalRunActiveStatus | LocalRunTerminalStatus;

export type LocalRunResultStatus =
  | LocalRunTerminalStatus
  | 'approved'
  | 'changes_requested'
  | 'addressed'
  | 'implemented'
  | 'fixed'
  | 'resolved'
  | 'planned'
  | 'skipped';

export interface LocalRunTarget {
  type: 'issue' | 'pr';
  number: number;
}

export interface LocalRunRunLink {
  runId: string;
  operationReference: string;
  normalizedOperationReference: string;
  target: LocalRunTarget;
  statePath: string;
}

export interface LocalRunChildRun extends LocalRunRunLink {
  status: string;
  startedAt: string;
  updatedAt: string;
  summary?: string;
}

export interface LocalRunState {
  schemaVersion: 1;
  runId: string;
  operationReference: string;
  normalizedOperationReference: string;
  target: LocalRunTarget;
  publicationMode: 'dry-run' | 'publish';
  runGoal: 'operation' | 'finalized';
  status: LocalRunStatus;
  phase: string;
  heartbeatToken: string;
  heartbeatIntervalMs: number;
  leaseDurationMs: number;
  heartbeatAt: string;
  heartbeatSummary?: string;
  leaseExpiresAt: string;
  lastEvent: Record<string, unknown>;
  parentRun?: LocalRunRunLink;
  childRuns: LocalRunChildRun[];
}

export interface LocalRunHeartbeatEnvironment extends NodeJS.ProcessEnv {
  PULLOPS_HEARTBEAT_COMMAND: string;
  PULLOPS_RUN_STATE_PATH: string;
  PULLOPS_HEARTBEAT_TOKEN: string;
  PULLOPS_HEARTBEAT_INTERVAL_MS: string;
  npm_config_cache: string;
}

export interface LocalRunStateRecord {
  statePath: string;
  state: LocalRunState;
  heartbeatEnvironment: LocalRunHeartbeatEnvironment;
  runLink: LocalRunRunLink;
}

export interface LocalRunRecord {
  directory: string;
  statePath: string;
  heartbeatEnvironment: LocalRunHeartbeatEnvironment;
  runLink: LocalRunRunLink;
}

export interface InitializeLocalRunStateOptions {
  runRecordDirectory: string;
  operationReference: string;
  target: LocalRunTarget;
  publicationMode: 'dry-run' | 'publish';
  runGoal?: 'operation' | 'finalized';
  phase?: string;
  createdAt?: Date;
  heartbeatIntervalMs?: number;
  leaseDurationMs?: number;
  parentRun?: LocalRunRunLink;
}

export interface RecordLocalRunHeartbeatOptions {
  statePath: string;
  token: string;
  summary?: string;
  at?: Date;
}

export interface RecordLocalRunTerminalStatusOptions {
  statePath: string;
  status: LocalRunTerminalStatus;
  summary: string;
  phase?: string;
  at?: Date;
}

export interface RecordLocalRunChildRunOptions {
  statePath: string;
  childRun: LocalRunChildRun;
}
