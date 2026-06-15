import type { GitHubPullRequest } from '../../github/types.js';

export type PrFinalizeSourceKind = 'standalone' | 'childIssue';

export type PrFinalizeSource =
  | {
      ready: false;
      output: Record<string, unknown>;
    }
  | {
      ready: true;
      sourceKind: 'standalone';
      sourceIssueNumber: number;
      baseBranch: string;
    }
  | {
      ready: true;
      sourceKind: 'childIssue';
      sourceIssueNumber: number;
      parentIssueNumber: number;
      baseBranch: string;
    };

export type PrFinalizePreparation =
  | { ready: false; output: Record<string, unknown> }
  | {
      ready: true;
      mode: 'rewrite';
      pullRequest: GitHubPullRequest;
      sourceKind: PrFinalizeSourceKind;
      sourceIssueNumber: number;
      parentIssueNumber?: number;
      baseBranch: string;
      currentTreeHash: string;
      reviewedTreeHash: string;
      changedFiles: string[];
    }
  | {
      ready: true;
      mode: 'finalized';
      pullRequest: GitHubPullRequest;
      sourceKind: PrFinalizeSourceKind;
      sourceIssueNumber: number;
      parentIssueNumber?: number;
      baseBranch: string;
      currentTreeHash: string;
      finalizedTreeHash: string;
      finalizedHeadSha: string;
    };
