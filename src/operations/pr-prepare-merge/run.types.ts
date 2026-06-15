import type { GitHubPullRequest } from '../../github/types.js';

export type PrPrepareMergePreparation =
  | { ready: false; output: Record<string, unknown> }
  | {
      ready: true;
      mode: 'rewrite';
      pullRequest: GitHubPullRequest;
      sourceIssueNumber: number;
      baseBranch: string;
      currentTreeHash: string;
      reviewedTreeHash: string;
      changedFiles: string[];
    }
  | {
      ready: true;
      mode: 'prepared';
      pullRequest: GitHubPullRequest;
      sourceIssueNumber: number;
      baseBranch: string;
      currentTreeHash: string;
      preparedTreeHash: string;
      preparedHeadSha: string;
    };
