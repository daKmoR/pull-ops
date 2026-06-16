import type { GitHubClient, GitHubPullRequest } from '../github/types.js';

export interface ManagedPrCycleState {
  current: number;
  max: number;
}

export type ManagedPrSourceKind = 'issue' | 'parentIssue';

export interface ManagedPrState {
  managed: boolean;
  sourceIssueNumber?: number;
  sourceKind?: ManagedPrSourceKind;
  lastOperation?: string;
  reviewedTreeHash?: string;
  finalizedTreeHash?: string;
  finalizedHeadSha?: string;
  mergeMethod?: string;
  reviewCycles: ManagedPrCycleState;
  ciFixCycles: ManagedPrCycleState;
}

export interface ManagedPrStateSectionOptions {
  status: string;
  source: {
    kind: ManagedPrSourceKind;
    number: number;
  };
  branchName: string;
  triggerActor?: string;
  runnerTask: string;
  modelTier: string;
  model: string;
  lastOperation: string;
  reviewCycles?: ManagedPrCycleState;
  ciFixCycles?: ManagedPrCycleState;
}

export interface UpdateManagedPrStateOptions {
  body: string;
  status?: string;
  lastOperation?: string;
  reviewCycles?: ManagedPrCycleState;
  ciFixCycles?: ManagedPrCycleState;
  reviewedTreeHash?: string;
  finalizedTreeHash?: string;
  finalizedHeadSha?: string;
  mergeMethod?: string;
  removeMergePreparationMarkers?: boolean;
}

export type ManagedPrTransitionOutcome =
  | {
      kind: 'approved';
      reviewCycle: number;
      maxReviewCycles: number;
      reviewedTreeHash?: string;
    }
  | {
      kind: 'changes-requested';
      reviewCycle: number;
      maxReviewCycles: number;
    }
  | {
      kind: 'addressed';
      reviewCycle: number;
      maxReviewCycles: number;
    }
  | {
      kind: 'fixed';
      ciFixCycle: number;
      maxCiFixCycles: number;
    }
  | {
      kind: 'no-failed-checks';
    }
  | {
      kind: 'updated';
    }
  | {
      kind: 'conflicts-found';
      baseBranch: string;
      conflictedFiles: string[];
    }
  | {
      kind: 'resolved';
    }
  | {
      kind: 'ready';
      finalizedTreeHash: string;
      finalizedHeadSha: string;
    }
  | {
      kind: 'route-to-review';
      reason: string;
    }
  | {
      kind: 'route-to-ci-fix';
      reason: string;
    }
  | {
      kind: 'blocked';
      reason: string;
      reviewCycle?: number;
      maxReviewCycles?: number;
      ciFixCycle?: number;
      maxCiFixCycles?: number;
    };

export interface ApplyManagedPrTransitionOptions {
  githubClient: GitHubClient;
  outputDirectory?: string;
  pullRequest: GitHubPullRequest;
  operation: string;
  outcome: ManagedPrTransitionOutcome;
}

export interface RefusePrOperationTargetOptions {
  githubClient: GitHubClient;
  outputDirectory?: string;
  pullRequest: GitHubPullRequest;
  operation: string;
  reason: string;
}

export interface ManagedPrTransitionResult {
  updatedBody: boolean;
  addedLabels: string[];
  removedLabels: string[];
  comment?: string;
  nextOperationLabel?: string;
  statusLabel?: string;
}

export interface InternalTransition {
  body?: string;
  failureReason?: string;
  removeLabels: string[];
  addLabelsBeforeRemove: string[];
  addLabelsAfterRemove: string[];
  commentBody?: string;
  nextOperationLabel?: string;
  statusLabel?: string;
}
