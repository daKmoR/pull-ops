import type {
  GitHubIssue,
  GitHubPullRequest,
  GitHubPullRequestDiff,
  GitHubPullRequestReviewContext,
} from '../../github/types.js';
import type { CheckFailureClassification, ClassifiedCheckFailure } from './classification.types.js';

export interface CheckClassificationComparison {
  checkId: string;
  checkName?: string;
  runnerClassification: CheckFailureClassification;
  runnerRationale: string;
  keywordPrior?: CheckFailureClassification;
  keywordPriorReason?: string;
  agreesWithKeywordPrior?: boolean;
}

export type PrFixCiPreparation =
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
