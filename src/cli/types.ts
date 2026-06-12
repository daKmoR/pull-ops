import type { ModelTier, PullOpsConfig } from '../config/types.js';
import type { GitHubClient } from '../github/types.js';

export interface WritableLike {
  write(chunk: string): void;
}

export interface OperationTarget {
  type: 'issue' | 'pr';
  number: number;
}

export interface OperationRunnerContext {
  operation: string;
  target: OperationTarget;
  config: PullOpsConfig;
  modelTier: ModelTier;
  model: string;
  githubClient: GitHubClient;
}

export type OperationRunner = (
  context: OperationRunnerContext,
) => Promise<Record<string, unknown>> | Record<string, unknown>;
