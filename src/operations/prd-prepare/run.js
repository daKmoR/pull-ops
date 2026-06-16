import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { PULL_OPS_OPERATION_LABELS, PULL_OPS_STATUS_LABELS } from '../../labels/pullOpsLabels.js';
import { createParentBranchName } from '../branchNames.js';
import { GITHUB_ACTIONS_BOT_AUTHOR } from '../githubActionsBot.js';
import { getParentIssueNumber } from '../issueDependencies.js';
import { createPrdPreparePullRequestBody } from './prBody.js';

/**
 * @typedef {import('../../cli/types.js').OperationRunnerContext} OperationRunnerContext
 * @typedef {import('../../github/types.js').GitHubIssue} GitHubIssue
 */

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
export async function runPrdPrepare(context) {
  assertIssueTarget(context);

  const issue = await context.githubClient.getIssue(context.target.number);
  if (issue.state !== 'OPEN') {
    return await blockPreparation(context, issue, {
      reason: `Issue #${issue.number} is ${issue.state.toLowerCase()}. PullOps can only prepare open parent issues.`,
    });
  }

  const parentIssueNumber = getParentIssueNumber(issue);
  if (parentIssueNumber !== undefined) {
    return await blockPreparation(context, issue, {
      reason: [
        `Issue #${issue.number} is already part of parent issue #${parentIssueNumber}.`,
        [
          `Use ${PULL_OPS_OPERATION_LABELS.issueImplement} on concrete child issues,`,
          `or ${PULL_OPS_OPERATION_LABELS.prdPrepare} on the parent issue.`,
        ].join(' '),
      ].join(' '),
    });
  }

  const branchName = createParentBranchName({
    branchPrefix: context.config.branchPrefix,
    parentNumber: issue.number,
  });
  const pullRequestBody = createPrdPreparePullRequestBody({
    issue,
    branchName,
    triggerActor: context.triggerActor,
    modelTier: context.modelTier,
    model: context.model,
  });

  const existingPullRequest = await context.githubClient.findOpenPullRequestByHead(branchName);
  if (existingPullRequest !== undefined) {
    await context.githubClient.updatePullRequestBody({
      number: existingPullRequest.number,
      body: pullRequestBody,
    });
    await markPreparationPrepared(context, issue);

    return {
      status: 'accepted',
      summary: `Updated existing umbrella PR #${existingPullRequest.number} for parent issue #${issue.number}.`,
      issue: issue.number,
      pullRequest: {
        number: existingPullRequest.number,
        url: existingPullRequest.url,
        branch: branchName,
        draft: existingPullRequest.isDraft,
      },
    };
  }

  try {
    await markPreparationInProgress(context, issue);
    await context.gitClient.createBranch({
      branchName,
      baseBranch: context.config.baseBranch,
    });
    await context.gitClient.commitEmpty({
      message: createPrdPrepareCommitMessage(issue),
      author: GITHUB_ACTIONS_BOT_AUTHOR,
    });
    await context.gitClient.pushBranch({ branchName });

    const pullRequest = await context.githubClient.createDraftPullRequest({
      title: `Prepare #${issue.number}: ${issue.title}`,
      body: pullRequestBody,
      baseBranch: context.config.baseBranch,
      headBranch: branchName,
    });
    await markPreparationPrepared(context, issue);

    return {
      status: 'accepted',
      summary: `Opened draft umbrella PR #${pullRequest.number} for parent issue #${issue.number}.`,
      issue: {
        number: issue.number,
        url: issue.url,
      },
      pullRequest: {
        number: pullRequest.number,
        url: pullRequest.url,
        branch: branchName,
        draft: pullRequest.isDraft,
      },
    };
  } catch (error) {
    await recordPreparationFailure(context, issue, getErrorMessage(error));
    throw error;
  }
}

/**
 * @param {GitHubIssue} issue
 * @returns {string}
 */
export function createPrdPrepareCommitMessage(issue) {
  return [
    `chore(prd): prepare #${issue.number}`,
    '',
    `Prepare umbrella branch for ${issue.title}.`,
    '',
    `Refs: #${issue.number}`,
  ].join('\n');
}

/**
 * @param {OperationRunnerContext} context
 * @returns {asserts context is OperationRunnerContext & { target: { type: 'issue', number: number } }}
 */
function assertIssueTarget(context) {
  if (context.target.type !== 'issue') {
    throw new Error('prd-prepare requires an issue target.');
  }
}

/**
 * @param {OperationRunnerContext} context
 * @param {GitHubIssue} issue
 * @param {{ reason: string }} options
 * @returns {Promise<Record<string, unknown>>}
 */
async function blockPreparation(context, issue, { reason }) {
  await writeFailureReason(context, reason);
  await context.githubClient.addLabelsToIssue({
    number: issue.number,
    labels: [PULL_OPS_STATUS_LABELS.blocked],
  });
  await context.githubClient.removeLabelsFromIssue({
    number: issue.number,
    labels: [
      PULL_OPS_OPERATION_LABELS.prdPrepare,
      PULL_OPS_STATUS_LABELS.inProgress,
      PULL_OPS_STATUS_LABELS.failed,
      PULL_OPS_STATUS_LABELS.prepared,
      PULL_OPS_STATUS_LABELS.done,
    ],
  });
  await context.githubClient.commentOnIssue({
    number: issue.number,
    body: ['PullOps could not complete `pullops run prd-prepare`.', '', `Reason: ${reason}`].join(
      '\n',
    ),
  });

  return {
    status: 'blocked',
    summary: reason,
    issue: issue.number,
  };
}

/**
 * @param {OperationRunnerContext} context
 * @param {GitHubIssue} issue
 * @returns {Promise<void>}
 */
async function markPreparationInProgress(context, issue) {
  await context.githubClient.addLabelsToIssue({
    number: issue.number,
    labels: [PULL_OPS_STATUS_LABELS.inProgress],
  });
  await context.githubClient.removeLabelsFromIssue({
    number: issue.number,
    labels: [
      PULL_OPS_STATUS_LABELS.blocked,
      PULL_OPS_STATUS_LABELS.failed,
      PULL_OPS_STATUS_LABELS.prepared,
      PULL_OPS_STATUS_LABELS.done,
    ],
  });
}

/**
 * @param {OperationRunnerContext} context
 * @param {GitHubIssue} issue
 * @returns {Promise<void>}
 */
async function markPreparationPrepared(context, issue) {
  await context.githubClient.addLabelsToIssue({
    number: issue.number,
    labels: [PULL_OPS_STATUS_LABELS.prepared],
  });
  await context.githubClient.removeLabelsFromIssue({
    number: issue.number,
    labels: [
      PULL_OPS_OPERATION_LABELS.prdPrepare,
      PULL_OPS_STATUS_LABELS.inProgress,
      PULL_OPS_STATUS_LABELS.blocked,
      PULL_OPS_STATUS_LABELS.done,
      PULL_OPS_STATUS_LABELS.failed,
    ],
  });
}

/**
 * @param {OperationRunnerContext} context
 * @param {GitHubIssue} issue
 * @param {string} reason
 * @returns {Promise<void>}
 */
async function recordPreparationFailure(context, issue, reason) {
  await writeFailureReason(context, reason);
  await context.githubClient.addLabelsToIssue({
    number: issue.number,
    labels: [PULL_OPS_STATUS_LABELS.failed],
  });
  await context.githubClient.removeLabelsFromIssue({
    number: issue.number,
    labels: [
      PULL_OPS_OPERATION_LABELS.prdPrepare,
      PULL_OPS_STATUS_LABELS.inProgress,
      PULL_OPS_STATUS_LABELS.blocked,
      PULL_OPS_STATUS_LABELS.prepared,
      PULL_OPS_STATUS_LABELS.done,
    ],
  });
  await context.githubClient.commentOnIssue({
    number: issue.number,
    body: ['PullOps could not complete `pullops run prd-prepare`.', '', `Reason: ${reason}`].join(
      '\n',
    ),
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
 * @param {unknown} error
 * @returns {string}
 */
function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
