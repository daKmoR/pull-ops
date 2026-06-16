import {
  PULL_OPS_OPERATION_LABELS,
  PULL_OPS_PR_OPERATION_LABELS,
  PULL_OPS_STATUS_LABEL_NAMES,
  PULL_OPS_STATUS_LABELS,
} from '../../labels/pullOpsLabels.js';
import { createParentBranchName, parseChildIssueBranchName } from '../branchNames.js';
import { getParentIssueNumber } from '../issueDependencies.js';
import { resumePrdAutomationForParentIssue } from '../prd-automation/run.js';

/** @type {ReadonlySet<string>} */
const ACTIVE_PULL_OPS_PR_LABELS = new Set([
  ...PULL_OPS_PR_OPERATION_LABELS,
  ...PULL_OPS_STATUS_LABEL_NAMES,
]);

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

  const alreadyClosed = issue.state === 'CLOSED';
  if (!alreadyClosed) {
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
  }

  const prdAutomation = await resumePrdAutomationForParentIssue(context, childBranch.parentNumber);
  const parentPullRequest = await requestParentReviewIfComplete(context, {
    parentIssueNumber: childBranch.parentNumber,
    parentBranchName: expectedBaseBranch,
  });

  return {
    status: 'accepted',
    summary: alreadyClosed
      ? `Child issue #${issue.number} is already closed.`
      : `Closed child issue #${issue.number} after PR #${pullRequest.number} merged into ${expectedBaseBranch}.`,
    issue: {
      number: issue.number,
      url: issue.url,
    },
    pullRequest: formatPullRequestResult(pullRequest),
    prdAutomation,
    parentPullRequest,
  };
}

/**
 * @param {OperationRunnerContext} context
 * @param {{ parentIssueNumber: number, parentBranchName: string }} options
 * @returns {Promise<Record<string, unknown>>}
 */
async function requestParentReviewIfComplete(context, { parentIssueNumber, parentBranchName }) {
  const parentIssue = await context.githubClient.getIssue(parentIssueNumber);
  const openChildIssues = parentIssue.subIssues.filter(childIssue => childIssue.state !== 'CLOSED');

  if (openChildIssues.length > 0) {
    return {
      status: 'waiting',
      issue: {
        number: parentIssue.number,
        url: parentIssue.url,
      },
      openChildIssues: openChildIssues.map(childIssue => childIssue.number),
    };
  }

  const pullRequest = await context.githubClient.findOpenPullRequestByHead(parentBranchName);
  if (pullRequest === undefined) {
    return {
      status: 'missing',
      branch: parentBranchName,
    };
  }

  if (hasActivePullOpsPrState(pullRequest.labels ?? [])) {
    return {
      status: 'already-active',
      pullRequest: formatPullRequestResult(pullRequest),
      labels: pullRequest.labels ?? [],
    };
  }

  await context.githubClient.addLabelsToPullRequest({
    number: pullRequest.number,
    labels: [PULL_OPS_OPERATION_LABELS.prReview],
  });

  return {
    status: 'review-requested',
    pullRequest: formatPullRequestResult(pullRequest),
  };
}

/**
 * @param {string[]} labels
 * @returns {boolean}
 */
function hasActivePullOpsPrState(labels) {
  return labels.some(label => ACTIVE_PULL_OPS_PR_LABELS.has(label));
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
