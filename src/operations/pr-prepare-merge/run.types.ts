import type {
  GitHubIssue,
  GitHubPullRequest,
  GitHubPullRequestDiff,
  GitHubPullRequestReviewContext,
} from '../../github/types.js';

export type PrPrepareMergePreparation =
  | { ready: false; output: Record<string, unknown> }
  | {
      ready: true;
      pullRequest: GitHubPullRequest;
      issue: GitHubIssue;
      sourceKind: 'issue' | 'parentIssue';
      sourceIssueNumber: number;
      baseBranch: string;
      reviewContext: GitHubPullRequestReviewContext;
      diff: GitHubPullRequestDiff;
      changedFiles: string[];
    };
