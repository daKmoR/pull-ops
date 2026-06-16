import type { GitHubIssue, GitHubIssueReference } from '../github/types.js';

export type PrdAutomationMode = 'auto-advance' | 'auto-complete';

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
  labels?: string[];
  branch?: string;
  pullRequest?: {
    number: number;
    url: string;
    baseBranch?: string;
    headBranch: string;
  };
  nextOperation?: string;
  checks?: number;
  mergeMethod?: string;
}

export interface ParentReviewResult {
  status: string;
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
