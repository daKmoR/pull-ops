import type { GitHubPullRequest } from '../../github/types.js';

export type PrPrepareMergeSourceKind = 'standalone' | 'childIssue';

export type PrPrepareMergeSource =
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

export type PrPrepareMergePreparation =
  | { ready: false; output: Record<string, unknown> }
  | {
      ready: true;
      mode: 'rewrite';
      pullRequest: GitHubPullRequest;
      sourceKind: PrPrepareMergeSourceKind;
      sourceIssueNumber: number;
      parentIssueNumber?: number;
      baseBranch: string;
      currentTreeHash: string;
      reviewedTreeHash: string;
      changedFiles: string[];
    }
  | {
      ready: true;
      mode: 'prepared';
      pullRequest: GitHubPullRequest;
      sourceKind: PrPrepareMergeSourceKind;
      sourceIssueNumber: number;
      parentIssueNumber?: number;
      baseBranch: string;
      currentTreeHash: string;
      preparedTreeHash: string;
      preparedHeadSha: string;
    };
