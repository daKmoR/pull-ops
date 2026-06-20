import type {
  GitHubIssue,
  GitHubPullRequest,
  GitHubPullRequestDiff,
  GitHubPullRequestReviewContext,
} from '../../github/types.js';
import type { ModelTier } from '../../config/types.js';

export type PrReviewPreparation =
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
      nextReviewCycle: number;
      maxReviewCycles: number;
    };
