import type {
  GitHubIssue,
  GitHubPullRequest,
  GitHubPullRequestDiff,
  GitHubPullRequestReviewContext,
} from '../../github/types.js';
import type { PrAddressReviewFeedbackItem } from './feedback.types.js';

export type AddressPrRevieweparation =
  | { ready: false; output: Record<string, unknown> }
  | {
      ready: true;
      pullRequest: GitHubPullRequest;
      issue: GitHubIssue;
      reviewContext: GitHubPullRequestReviewContext;
      diff: GitHubPullRequestDiff;
      feedbackItems: PrAddressReviewFeedbackItem[];
      reviewCycle: number;
      maxReviewCycles: number;
    };
