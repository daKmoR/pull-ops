import type { OperationRunnerContext } from '../cli/types.js';
import type {
  GitHubIssue,
  GitHubPullRequest,
  GitHubPullRequestDiff,
  GitHubPullRequestReviewContext,
} from '../github/types.js';
import type { LocalRunRecord } from '../local-run-state/types.js';

/** The shared guardrail preparation handed to an Operation Module's local flow. */
export interface PreparedLocalPullRequestOperation {
  pullRequest: GitHubPullRequest;
  issue: GitHubIssue;
  reviewContext: GitHubPullRequestReviewContext;
  diff: GitHubPullRequestDiff;
}

/** An Operation Module's local dry-run flow for one prepared PR operation. */
export type LocalPullRequestOperationFlow = (
  context: OperationRunnerContext,
  runRecord: LocalRunRecord,
  preparation: PreparedLocalPullRequestOperation,
) => Promise<Record<string, unknown>>;

export interface RunLocalPullRequestOperationOptions {
  /**
   * The Operation Module's local flow. Operations without one are blocked as
   * not implemented for local execution after the shared guardrails run.
   */
  runPrepared?: LocalPullRequestOperationFlow;
}
