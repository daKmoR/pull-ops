import type { GitHubClient, GitHubPullRequest } from '../github/types.js';

export interface ManagedPrCycleState {
  current: number;
  max: number;
}

export interface ManagedPrRunBudgetUsage {
  usedTokens: number;
  durationMs: number;
}

export interface ManagedPrOperationUsage {
  usedTokens?: number;
  durationMs?: number;
  treeHash?: string;
}

export type ManagedPrRunBudgetExhaustion =
  | { exhausted: false }
  | { exhausted: true; reason: string };

export interface ManagedPrSpecialReviewState {
  escalationReviewCycles?: ManagedPrCycleState;
  humanFeedbackResponseStateMarkersPresent?: boolean;
  humanFeedbackResponseCycles?: number;
  processedHumanFeedbackReviewIds?: string[];
  pendingHumanFeedbackReviewId?: string;
  reviewFollowUpIssueNumbers?: number[];
}

export type ManagedPrReviewMode = 'normal' | 'escalation' | 'human-feedback-response';

export type ManagedPrSourceKind = 'issue' | 'parentIssue';

export interface ManagedPrState extends ManagedPrSpecialReviewState {
  managed: boolean;
  status?: string;
  sourceIssueNumber?: number;
  sourceKind?: ManagedPrSourceKind;
  lastOperation?: string;
  reviewedTreeHash?: string;
  finalizedTreeHash?: string;
  finalizedHeadSha?: string;
  mergeMethod?: string;
  reviewCycles: ManagedPrCycleState;
  ciFixCycles: ManagedPrCycleState;
  runBudgetUsage: ManagedPrRunBudgetUsage;
  lastCycleTreeHash?: string;
}

export interface ManagedPrStateSectionOptions extends ManagedPrSpecialReviewState {
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

export interface UpdateManagedPrStateOptions extends ManagedPrSpecialReviewState {
  body: string;
  status?: string;
  lastOperation?: string;
  reviewCycles?: ManagedPrCycleState;
  ciFixCycles?: ManagedPrCycleState;
  reviewedTreeHash?: string;
  finalizedTreeHash?: string;
  finalizedHeadSha?: string;
  mergeMethod?: string;
  runBudgetUsage?: ManagedPrRunBudgetUsage;
  lastCycleTreeHash?: string;
  removeMergePreparationMarkers?: boolean;
}

export type ManagedPrTransitionOutcome =
  | {
      kind: 'approved';
      reviewCycle: number;
      maxReviewCycles: number;
      reviewedTreeHash?: string;
      reviewMode?: ManagedPrReviewMode;
      reviewFollowUpIssueNumbers?: number[];
    }
  | {
      kind: 'changes-requested';
      reviewCycle: number;
      maxReviewCycles: number;
      reviewMode?: ManagedPrReviewMode;
      /** Runner-proposed next operation; applied only when the transition graph allows it. */
      proposedNextOperation?: string;
    }
  | {
      kind: 'addressed';
      reviewCycle: number;
      maxReviewCycles: number;
      reviewId?: string;
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
  usage?: ManagedPrOperationUsage;
  suppressFollowUpOperationLabels?: boolean;
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

export interface ManagedPrWorkflowResult {
  status:
    | 'already-active'
    | 'finalized'
    | 'not-managed'
    | 'review-requested'
    | 'resumed'
    | 'waiting';
  pullRequest: {
    number: number;
    url: string;
    baseBranch?: string;
    headBranch: string;
  };
  labels?: string[];
  nextOperation?: string;
}

export interface ManagedPrWorkflowOptions {
  githubClient: GitHubClient;
  pullRequest: GitHubPullRequest;
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
