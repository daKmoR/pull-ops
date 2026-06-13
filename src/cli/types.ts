import type { ModelTier, PullOpsConfig } from '../config/types.js';
import type { GitClient } from '../git/types.js';
import type { GitHubClient } from '../github/types.js';
import type { CodexRunner } from '../runner/types.js';

export interface WritableLike {
  write(chunk: string): void;
}

export interface OperationTarget {
  type: 'issue' | 'pr';
  number: number;
}

export interface OperationRunnerContext {
  operation: string;
  phase: OperationPhase;
  target: OperationTarget;
  cwd: string;
  config: PullOpsConfig;
  modelTier: ModelTier;
  model: string;
  githubClient: GitHubClient;
  gitClient: GitClient;
  codexRunner: CodexRunner;
  triggerActor?: string;
  outputDirectory?: string;
  codexActionOutcome?: string;
}

export type OperationPhase = 'run' | 'prepare-codex' | 'finalize-codex';

export type OperationRunner = (
  context: OperationRunnerContext,
) => Promise<Record<string, unknown>> | Record<string, unknown>;
