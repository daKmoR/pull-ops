import { PULL_OPS_OPERATION_LABELS, PULL_OPS_STATUS_LABELS } from '../../labels/pullOpsLabels.js';
import { createParentBranchName, parseChildIssueBranchName } from '../branchNames.js';
import { getParentIssueNumber } from '../issueDependencies.js';

/**
 * @typedef {import('../../cli/types.js').OperationRunnerContext} OperationRunnerContext
 * @typedef {import('../../github/types.js').GitHubPullRequest} GitHubPullRequest
 */

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
export async function runPrCloseChildIssue(context) {
  assertPullRequestTarget(context);

  const pullRequest = await context.githubClient.getPullRequest(context.target.number);
  if (pullRequest.isCrossRepository === true) {
    return skipped(pullRequest, `PR #${pullRequest.number} is not a same-repository PR.`);
  }

  const childBranch = parseChildIssueBranchName({
    branchPrefix: context.config.branchPrefix,
    branchName: pullRequest.headRefName,
  });

  if (childBranch === undefined) {
    return skipped(pullRequest, `PR #${pullRequest.number} is not a PRD child issue PR.`);
  }

  const expectedBaseBranch = createParentBranchName({
    branchPrefix: context.config.branchPrefix,
    parentNumber: childBranch.parentNumber,
  });

  if (pullRequest.baseRefName !== expectedBaseBranch) {
    return skipped(
      pullRequest,
      `PR #${pullRequest.number} does not target expected PRD branch ${expectedBaseBranch}.`,
    );
  }

  if (!isMergedPullRequest(pullRequest)) {
    return skipped(pullRequest, `PR #${pullRequest.number} is not merged.`);
  }

  const issue = await context.githubClient.getIssue(childBranch.issueNumber);
  const actualParentIssueNumber = getParentIssueNumber(issue);

  if (actualParentIssueNumber !== childBranch.parentNumber) {
    return skipped(
      pullRequest,
      [
        `Issue #${issue.number} is not part of PRD issue #${childBranch.parentNumber}.`,
        'PullOps will not close it from this child PR.',
      ].join(' '),
    );
  }

  if (issue.state === 'CLOSED') {
    return {
      status: 'accepted',
      summary: `Child issue #${issue.number} is already closed.`,
      issue: {
        number: issue.number,
        url: issue.url,
      },
      pullRequest: formatPullRequestResult(pullRequest),
    };
  }

  await context.githubClient.closeIssue({
    number: issue.number,
    comment: [
      `PullOps closed this Child Issue because PR #${pullRequest.number} merged into`,
      `the PRD branch \`${expectedBaseBranch}\`.`,
    ].join(' '),
  });
  await context.githubClient.removeLabelsFromIssue({
    number: issue.number,
    labels: [
      PULL_OPS_OPERATION_LABELS.issueImplement,
      PULL_OPS_STATUS_LABELS.inProgress,
      PULL_OPS_STATUS_LABELS.blocked,
      PULL_OPS_STATUS_LABELS.prepared,
      PULL_OPS_STATUS_LABELS.failed,
    ],
  });
  await context.githubClient.addLabelsToIssue({
    number: issue.number,
    labels: [PULL_OPS_STATUS_LABELS.done],
  });

  return {
    status: 'accepted',
    summary: `Closed child issue #${issue.number} after PR #${pullRequest.number} merged into ${expectedBaseBranch}.`,
    issue: {
      number: issue.number,
      url: issue.url,
    },
    pullRequest: formatPullRequestResult(pullRequest),
  };
}

/**
 * @param {GitHubPullRequest} pullRequest
 * @param {string} summary
 * @returns {Record<string, unknown>}
 */
function skipped(pullRequest, summary) {
  return {
    status: 'skipped',
    summary,
    pullRequest: formatPullRequestResult(pullRequest),
  };
}

/**
 * @param {GitHubPullRequest} pullRequest
 * @returns {{ number: number, url: string, baseBranch: string | undefined, headBranch: string }}
 */
function formatPullRequestResult(pullRequest) {
  return {
    number: pullRequest.number,
    url: pullRequest.url,
    baseBranch: pullRequest.baseRefName,
    headBranch: pullRequest.headRefName,
  };
}

/**
 * @param {GitHubPullRequest} pullRequest
 * @returns {boolean}
 */
function isMergedPullRequest(pullRequest) {
  return pullRequest.state === 'MERGED' || pullRequest.mergedAt !== undefined;
}

/**
 * @param {OperationRunnerContext} context
 * @returns {asserts context is OperationRunnerContext & { target: { type: 'pr', number: number } }}
 */
function assertPullRequestTarget(context) {
  if (context.target.type !== 'pr') {
    throw new Error('pr-close-child-issue requires a pull request target.');
  }
}
