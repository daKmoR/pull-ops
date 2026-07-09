import type { LocalRunState } from '../local-run-state/types.js';

export type OperationProgressEventName =
  | 'run.started'
  | 'phase.started'
  | 'phase.completed'
  | 'ticket.started'
  | 'ticket.progress'
  | 'child.heartbeat'
  | 'ticket.completed'
  | 'ticket.blocked'
  | 'waiting'
  | 'run.summary';

export interface SupervisedRunTarget {
  type: 'issue' | 'pr';
  number: number;
}

export interface OperationProgressEventWriter {
  runId: string;
  operationLabelReference: string;
  target: SupervisedRunTarget;
  bindLocalRunRecord(localRunRecord: string): Promise<void>;
  emit(
    event: OperationProgressEventName,
    details?: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
}

export type RunStallReason = 'terminal-status' | 'lease-active' | 'live-signal' | 'lease-expired';

export interface RunStallClassification {
  stalled: boolean;
  reason: RunStallReason;
  status: string;
  leaseExpiresAt: string;
  lastHeartbeatAt: string;
  heartbeatCount: number;
  expiredForMs?: number;
}

export interface HeartbeatDelivery {
  runState: LocalRunState;
  warning?: string;
}

export interface HeartbeatIfDueResult {
  emitted: boolean;
  heartbeatIntervalMs: number;
  warning?: string;
}
