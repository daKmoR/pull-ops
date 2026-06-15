import type { GitConflictContext, GitRebaseStepResult } from '../../git/types.js';
import type { GitHubIssue, GitHubPullRequest } from '../../github/types.js';

export interface PrResolveConflictsReadyPreparation {
  ready: true;
  pullRequest: GitHubPullRequest;
  issue?: GitHubIssue;
  baseBranch: string;
  managed: boolean;
  maxConflictResolutionPasses: number;
}

export type PrResolveConflictsPreparation =
  | { ready: false; output: Record<string, unknown> }
  | PrResolveConflictsReadyPreparation;

export interface ConflictResolutionPassState {
  pass: number;
}

export type StartOrReadRebaseResult = GitRebaseStepResult;

export interface ActiveConflictResolution {
  conflictContext: GitConflictContext;
  pass: number;
}
