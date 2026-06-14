import type {
  GitHubIssue,
  GitHubPullRequest,
  GitHubPullRequestDiff,
  GitHubPullRequestReviewContext,
} from '../../github/types.js';
import type { AddressReviewFeedbackItem } from './feedback.types.js';

export type AddressReviewPreparation =
  | { ready: false; output: Record<string, unknown> }
  | {
      ready: true;
      pullRequest: GitHubPullRequest;
      issue: GitHubIssue;
      reviewContext: GitHubPullRequestReviewContext;
      diff: GitHubPullRequestDiff;
      feedbackItems: AddressReviewFeedbackItem[];
      reviewCycle: number;
      maxReviewCycles: number;
    };
