import type { ModelTier, PullOpsConfig } from '../config/types.js';
import type { GitClient } from '../git/types.js';
import type { GitHubClient } from '../github/types.js';
import type { LocalRunRunLink } from '../local-run-state/types.js';
import type {
  PullOpsParentEventSink,
  PullOpsParentEventSinkChildEnvironment,
} from '../parent-event-sink/types.js';
import type {
  Runner,
  ExternalRunnerCommandRunner,
  ExternalRunnerJobRunner,
  RunnerAdapter,
} from '../runner/types.js';

export interface WritableLike {
  write(chunk: string | Uint8Array): void;
}

export interface OperationTarget {
  type: 'issue' | 'pr';
  number: number;
}

export type OperationProgressEventName =
  | 'run.started'
  | 'phase.started'
  | 'phase.completed'
  | 'child.started'
  | 'child.progress'
  | 'child.heartbeat'
  | 'child.completed'
  | 'child.blocked'
  | 'waiting'
  | 'run.summary';

export interface OperationProgressEventWriter {
  runId: string;
  operationLabelReference: string;
  target: OperationTarget;
  bindLocalRunRecord(localRunRecord: string): Promise<void>;
  emit(
    event: OperationProgressEventName,
    details?: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
}

export interface OperationRunnerContext {
  operation: string;
  phase: OperationPhase;
  runnerAdapter: RunnerAdapter;
  executionBackend?: ExecutionBackend;
  publicationMode?: PublicationMode;
  runGoal?: OperationRunGoal;
  resumeParentPrdAutomationAfterPrFinalize?: boolean;
  allowAbsentReviewedHeadChecks?: boolean;
  suppressFollowUpOperationLabels?: boolean;
  target: OperationTarget;
  cwd: string;
  config: PullOpsConfig;
  modelTier: ModelTier;
  model: string;
  githubClient: GitHubClient;
  gitClient: GitClient;
  runner: Runner;
  triggerActor?: string;
  reviewId?: string;
  outputDirectory?: string;
  localRunRecordDirectory?: string;
  reasoningEffort?: string;
  contextUsage?: OperationContextUsage;
  suppressRunnerOutput?: boolean;
  progress?: (message: string) => void;
  progressEventWriter?: OperationProgressEventWriter;
  externalRunnerJobRunner?: ExternalRunnerJobRunner;
  externalRunnerCommandRunner?: ExternalRunnerCommandRunner;
  virtualCompletedIssueNumbers?: number[];
  parentRun?: LocalRunRunLink;
  parentEventSink?: PullOpsParentEventSink;
  parentEventSinkEnvironment?: PullOpsParentEventSinkChildEnvironment;
}

export interface OperationContextUsage {
  used: number;
  limit?: number;
}

export type OperationPhase = 'run' | 'prepare' | 'complete';
export type ExecutionBackend = 'local' | 'github-actions';
export type PublicationMode = 'dry-run' | 'publish';
export type OperationRunGoal = 'operation' | 'finalized';

export type OperationRunner = (
  context: OperationRunnerContext,
) => Promise<Record<string, unknown>> | Record<string, unknown>;
