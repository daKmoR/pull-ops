import type { GitHubIssue, GitHubIssueReference } from '../github/types.js';

export type PrdAutomationMode = 'auto-advance' | 'auto-complete';

export interface PrdAutomationRunBlocker {
  targetKind: 'issue' | 'pull-request';
  targetNumber?: number;
  phase: string;
  operationLabelReference?: string;
  reason: string;
  message: string;
  retryable: boolean;
}

export interface PrdAutomationSuggestedCommandAction {
  kind: 'command';
  description: string;
  argv: string[];
  approvalRequired: boolean;
  approvalReason?: string;
}

export interface IssueWorkTarget {
  issue: GitHubIssue;
  parentIssueNumber?: number;
  branchName: string;
  baseBranch: string;
}

export interface ChildAutomationResult {
  issue: {
    number: number;
    url: string;
  };
  status: string;
  summary: string;
  blockedBy?: number[];
  blockedPhase?: string;
  blockedOperation?: string;
  dependencyDecision?: ChildDependencyDecision;
  labels?: string[];
  branch?: string;
  localRunRecord?: string;
  publicationMode?: 'dry-run' | 'publish';
  pullRequest?: {
    number: number;
    url: string;
    baseBranch?: string;
    headBranch: string;
  };
  nextOperation?: string;
  checks?: number;
  mergeMethod?: string;
  conflictedFiles?: string[];
  finalizedHeadSha?: string;
  headSha?: string;
  treeHash?: string;
}

export interface ChildDependencyDecision {
  blockedBy: number[];
  satisfiedByClosedIssues: number[];
  satisfiedByVirtualCompletions: number[];
  remainingBlockedBy: number[];
}

export interface ParentReviewResult {
  status: string;
  summary?: string;
  issue?: {
    number: number;
    url: string;
  };
  openChildIssues?: number[];
  branch?: string;
  pullRequest?: {
    number: number;
    url: string;
    baseBranch?: string;
    headBranch: string;
  };
  labels?: string[];
  nextOperation?: string;
  review?: Record<string, unknown>;
  addressReviews?: Record<string, unknown>[];
  finalize?: Record<string, unknown>;
  localRunRecords?: string[];
}

export interface PrdAutomationResult extends Record<string, unknown> {
  status: string;
  summary: string;
  mode?: PrdAutomationMode;
  issue?:
    | {
        number: number;
        url: string;
      }
    | number;
  preparation?: Record<string, unknown>;
  children?: ChildAutomationResult[];
  parentPullRequest?: ParentReviewResult;
  publicationMode?: 'dry-run' | 'publish';
  branch?: string;
  localRunRecord?: string;
  localNextSteps?: string[];
  nextSteps?: string[];
  blockers?: PrdAutomationRunBlocker[];
  suggestedActions?: PrdAutomationSuggestedCommandAction[];
  virtualCompletedChildren?: number[];
  remainingBlockedChildren?: number[];
}

export interface ChildIssueCloseResult extends Record<string, unknown> {
  status: string;
  summary: string;
  issue?: {
    number: number;
    url: string;
  };
  pullRequest?: {
    number: number;
    url: string;
    baseBranch?: string;
    headBranch: string;
  };
  prdAutomation?: PrdAutomationResult;
  parentPullRequest?: ParentReviewResult;
}

export interface ParentIssueFacts {
  parentIssue: GitHubIssue;
  childIssues: GitHubIssueReference[];
  closedChildIssues: GitHubIssueReference[];
  openChildIssues: GitHubIssueReference[];
}

export interface ChildIssuePrFacts {
  sourceIssue: GitHubIssue;
  parentIssueNumber: number;
  expectedBaseBranch: string;
  expectedChildBranch: string;
}
