import type {
  GitHubIssue,
  GitHubPullRequest,
  GitHubPullRequestDiff,
  GitHubPullRequestReviewContext,
} from '../../github/types.js';
import type { FailedCheck } from './failedChecks.types.js';

export type PrFixCiPreparation =
  | { ready: false; output: Record<string, unknown> }
  | {
      ready: true;
      pullRequest: GitHubPullRequest;
      issue?: GitHubIssue;
      reviewContext: GitHubPullRequestReviewContext;
      diff: GitHubPullRequestDiff;
      checkFailures: FailedCheck[];
      managed: boolean;
      ciFixCycle: number;
      maxCiFixCycles: number;
    };
