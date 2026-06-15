import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  PULL_OPS_OPERATION_LABELS,
  PULL_OPS_STATUS_LABEL_NAMES,
  PULL_OPS_STATUS_LABELS,
} from '../../labels/pullOpsLabels.js';
import {
  readPullOpsPullRequestState,
  updatePullRequestBodyForPrUpdateBranch,
} from '../pr-review/prBody.js';

/**
 * @typedef {import('../../cli/types.js').OperationRunnerContext} OperationRunnerContext
 * @typedef {import('../../github/types.js').GitHubPullRequest} GitHubPullRequest
 * @typedef {import('../../git/types.js').GitRebaseResult} GitRebaseResult
 * @typedef {import('../../git/types.js').GitPushWithLeaseResult} GitPushWithLeaseResult
 */

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
export async function runPrUpdateBranch(context) {
  assertPullRequestTarget(context);

  const pullRequest = await context.githubClient.getPullRequest(context.target.number);
  const state = readPullOpsPullRequestState(pullRequest.body);

  if (pullRequest.isCrossRepository === true) {
    return await refusePullRequest(
      context,
      pullRequest,
      `PullOps v1 only updates same-repository PR branches. PR #${pullRequest.number} comes from a fork.`,
      { updateBody: state.managed },
    );
  }

  const baseBranch = pullRequest.baseRefName ?? context.config.baseBranch;

  try {
    const rebaseResult = await context.gitClient.rebaseBranchOntoBase({
      branchName: pullRequest.headRefName,
      baseBranch,
    });

    if (rebaseResult.status === 'conflicts') {
      return await handOffConflicts(context, pullRequest, rebaseResult, {
        baseBranch,
        updateBody: state.managed,
      });
    }

    const pushResult = await context.gitClient.pushBranchWithLease({
      branchName: pullRequest.headRefName,
    });

    if (pushResult.status === 'stale-lease') {
      return await blockStaleLease(context, pullRequest, {
        baseBranch,
        updateBody: state.managed,
      });
    }

    return await completeBranchUpdate(context, pullRequest, rebaseResult, pushResult, {
      baseBranch,
      updateBody: state.managed,
    });
  } catch (error) {
    await recordPullRequestFailure(context, pullRequest, getErrorMessage(error), {
      updateBody: state.managed,
    });
    throw error;
  }
}

/**
 * @param {OperationRunnerContext} context
 * @param {GitHubPullRequest} pullRequest
 * @param {GitRebaseResult & { status: 'rebased' }} rebaseResult
 * @param {GitPushWithLeaseResult & { status: 'pushed' }} pushResult
 * @param {{ baseBranch: string, updateBody: boolean }} options
 * @returns {Promise<Record<string, unknown>>}
 */
async function completeBranchUpdate(
  context,
  pullRequest,
  rebaseResult,
  pushResult,
  { baseBranch, updateBody },
) {
  if (updateBody) {
    await context.githubClient.updatePullRequestBody({
      number: pullRequest.number,
      body: updatePullRequestBodyForPrUpdateBranch({
        body: pullRequest.body,
        updateStatus: 'updated',
      }),
    });
  }

  await context.githubClient.removeLabelsFromPullRequest({
    number: pullRequest.number,
    labels: [PULL_OPS_OPERATION_LABELS.prUpdateBranch, ...PULL_OPS_STATUS_LABEL_NAMES],
  });
  await context.githubClient.addLabelsToPullRequest({
    number: pullRequest.number,
    labels: [PULL_OPS_OPERATION_LABELS.prReview],
  });

  return {
    status: 'accepted',
    summary: `Updated PR #${pullRequest.number} branch "${pullRequest.headRefName}" onto ${baseBranch}.`,
    pullRequest: {
      number: pullRequest.number,
      url: pullRequest.url,
    },
    prUpdateBranch: {
      baseBranch,
      branchName: pullRequest.headRefName,
      headSha: pushResult.headSha,
      treeHash: pushResult.treeHash,
      rebasedHeadSha: rebaseResult.headSha,
      rebasedTreeHash: rebaseResult.treeHash,
    },
  };
}

/**
 * @param {OperationRunnerContext} context
 * @param {GitHubPullRequest} pullRequest
 * @param {GitRebaseResult & { status: 'conflicts' }} rebaseResult
 * @param {{ baseBranch: string, updateBody: boolean }} options
 * @returns {Promise<Record<string, unknown>>}
 */
async function handOffConflicts(context, pullRequest, rebaseResult, { baseBranch, updateBody }) {
  const summary = [
    `Rebasing PR #${pullRequest.number} onto ${baseBranch} produced conflicts.`,
    `Handing off to ${PULL_OPS_OPERATION_LABELS.prResolveConflicts}.`,
  ].join(' ');

  if (updateBody) {
    await context.githubClient.updatePullRequestBody({
      number: pullRequest.number,
      body: updatePullRequestBodyForPrUpdateBranch({
        body: pullRequest.body,
        updateStatus: 'conflicts',
      }),
    });
  }

  await context.githubClient.removeLabelsFromPullRequest({
    number: pullRequest.number,
    labels: [PULL_OPS_OPERATION_LABELS.prUpdateBranch, ...PULL_OPS_STATUS_LABEL_NAMES],
  });
  await context.githubClient.addLabelsToPullRequest({
    number: pullRequest.number,
    labels: [PULL_OPS_OPERATION_LABELS.prResolveConflicts],
  });
  await context.githubClient.commentOnPullRequest({
    number: pullRequest.number,
    body: [
      'PullOps could not complete `pullops run pr-update-branch` without conflicts.',
      '',
      `Base branch: ${baseBranch}`,
      `Conflicted files: ${formatList(rebaseResult.conflictedFiles)}`,
      `Next operation: ${PULL_OPS_OPERATION_LABELS.prResolveConflicts}`,
    ].join('\n'),
  });

  return {
    status: 'accepted',
    summary,
    pullRequest: {
      number: pullRequest.number,
      url: pullRequest.url,
    },
    prUpdateBranch: {
      baseBranch,
      branchName: pullRequest.headRefName,
      conflicts: rebaseResult.conflictedFiles,
      handedOffTo: PULL_OPS_OPERATION_LABELS.prResolveConflicts,
    },
  };
}

/**
 * @param {OperationRunnerContext} context
 * @param {GitHubPullRequest} pullRequest
 * @param {{ baseBranch: string, updateBody: boolean }} options
 * @returns {Promise<Record<string, unknown>>}
 */
async function blockStaleLease(context, pullRequest, { baseBranch, updateBody }) {
  const reason = [
    `Concurrent branch advancement was detected for PR #${pullRequest.number}.`,
    'The force-with-lease push was rejected, so PullOps did not overwrite the remote branch.',
  ].join(' ');

  await recordPullRequestFailure(context, pullRequest, reason, { updateBody });

  return {
    status: 'blocked',
    summary: reason,
    pullRequest: {
      number: pullRequest.number,
      url: pullRequest.url,
    },
    prUpdateBranch: {
      baseBranch,
      branchName: pullRequest.headRefName,
      staleLease: true,
    },
  };
}

/**
 * @param {OperationRunnerContext} context
 * @param {GitHubPullRequest} pullRequest
 * @param {string} reason
 * @param {{ updateBody: boolean }} options
 * @returns {Promise<Record<string, unknown>>}
 */
async function refusePullRequest(context, pullRequest, reason, { updateBody }) {
  await recordPullRequestFailure(context, pullRequest, reason, { updateBody });

  return {
    status: 'refused',
    summary: reason,
    pullRequest: {
      number: pullRequest.number,
      url: pullRequest.url,
    },
  };
}

/**
 * @param {OperationRunnerContext} context
 * @param {GitHubPullRequest} pullRequest
 * @param {string} reason
 * @param {{ updateBody: boolean }} options
 * @returns {Promise<void>}
 */
async function recordPullRequestFailure(context, pullRequest, reason, { updateBody }) {
  await writeFailureReason(context, reason);

  if (updateBody) {
    await context.githubClient.updatePullRequestBody({
      number: pullRequest.number,
      body: updatePullRequestBodyForPrUpdateBranch({
        body: pullRequest.body,
        updateStatus: 'blocked',
      }),
    });
  }

  await context.githubClient.addLabelsToPullRequest({
    number: pullRequest.number,
    labels: [PULL_OPS_STATUS_LABELS.blocked],
  });
  await context.githubClient.removeLabelsFromPullRequest({
    number: pullRequest.number,
    labels: [
      PULL_OPS_OPERATION_LABELS.prUpdateBranch,
      PULL_OPS_STATUS_LABELS.inProgress,
      PULL_OPS_STATUS_LABELS.failed,
      PULL_OPS_STATUS_LABELS.prepared,
      PULL_OPS_STATUS_LABELS.done,
    ],
  });
  await context.githubClient.commentOnPullRequest({
    number: pullRequest.number,
    body: [
      'PullOps could not complete `pullops run pr-update-branch`.',
      '',
      `Reason: ${reason}`,
    ].join('\n'),
  });
}

/**
 * @param {OperationRunnerContext} context
 * @param {string} reason
 * @returns {Promise<void>}
 */
async function writeFailureReason(context, reason) {
  if (context.outputDirectory === undefined || context.outputDirectory.trim() === '') {
    return;
  }

  await mkdir(context.outputDirectory, { recursive: true });
  await writeFile(join(context.outputDirectory, 'failure_reason.txt'), `${reason}\n`);
}

/**
 * @param {string[]} values
 * @returns {string}
 */
function formatList(values) {
  return values.length === 0 ? 'none reported' : values.join(', ');
}

/**
 * @param {OperationRunnerContext} context
 * @returns {asserts context is OperationRunnerContext & { target: { type: 'pr', number: number } }}
 */
function assertPullRequestTarget(context) {
  if (context.target.type !== 'pr') {
    throw new Error('pr-update-branch requires a pull request target.');
  }
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
