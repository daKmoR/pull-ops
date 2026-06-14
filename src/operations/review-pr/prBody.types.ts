import type { ReviewResultStatus } from './output.types.js';

export type { ReviewResultStatus };

export type AddressReviewStatus = 'addressed' | 'blocked';

export interface PullOpsCycleState {
  current: number;
  max: number;
}

export interface PullOpsPullRequestState {
  managed: boolean;
  sourceIssueNumber?: number;
  sourceKind?: 'issue' | 'parentIssue';
  lastOperation?: string;
  reviewCycles: PullOpsCycleState;
  ciFixCycles: PullOpsCycleState;
}
