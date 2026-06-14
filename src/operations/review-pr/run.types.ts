import type {
  GitHubIssue,
  GitHubPullRequest,
  GitHubPullRequestDiff,
  GitHubPullRequestReviewContext,
} from '../../github/types.js';

export type ReviewPrPreparation =
  | { ready: false; output: Record<string, unknown> }
  | {
      ready: true;
      pullRequest: GitHubPullRequest;
      issue: GitHubIssue;
      reviewContext: GitHubPullRequestReviewContext;
      diff: GitHubPullRequestDiff;
      nextReviewCycle: number;
      maxReviewCycles: number;
    };
