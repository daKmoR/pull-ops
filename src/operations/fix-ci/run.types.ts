import type {
  GitHubIssue,
  GitHubPullRequest,
  GitHubPullRequestDiff,
  GitHubPullRequestReviewContext,
} from '../../github/types.js';
import type { ClassifiedCheckFailure } from './classification.types.js';

export type FixCiPreparation =
  | { ready: false; output: Record<string, unknown> }
  | {
      ready: true;
      pullRequest: GitHubPullRequest;
      issue?: GitHubIssue;
      reviewContext: GitHubPullRequestReviewContext;
      diff: GitHubPullRequestDiff;
      checkFailures: ClassifiedCheckFailure[];
      managed: boolean;
      ciFixCycle: number;
      maxCiFixCycles: number;
    };
