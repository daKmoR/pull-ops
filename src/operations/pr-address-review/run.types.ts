import type {
  GitHubIssue,
  GitHubPullRequest,
  GitHubPullRequestDiff,
  GitHubPullRequestReviewContext,
} from '../../github/types.js';
import type { ModelTier } from '../../config/types.js';
import type { PrAddressReviewFeedbackItem } from './feedback.types.js';

export type AddressPrRevieweparation =
  | { ready: false; output: Record<string, unknown> }
  | {
      ready: true;
      reviewMode: 'normal' | 'escalation' | 'human-feedback-response';
      modelTier: ModelTier;
      model: string;
      pullRequest: GitHubPullRequest;
      issue: GitHubIssue;
      reviewContext: GitHubPullRequestReviewContext;
      diff: GitHubPullRequestDiff;
      feedbackItems: PrAddressReviewFeedbackItem[];
      reviewCycle: number;
      maxReviewCycles: number;
    };
