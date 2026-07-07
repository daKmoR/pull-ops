import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { PULL_OPS_STATUS_LABELS } from '../../labels/pullOpsLabels.js';
import { createIssueBranchName, createParentBranchName } from '../branchNames.js';
import { GITHUB_ACTIONS_BOT_AUTHOR } from '../githubActionsBot.js';
import { createIssueSnapshot } from '../../issue-store/issueSnapshot.js';
import { requireOperationCatalogOperationLabelName } from '../operationCatalog.js';
import { createPrdPreparePullRequestBody } from './prBody.js';

/**
 * @typedef {import('../../cli/types.js').OperationRunnerContext} OperationRunnerContext
 * @typedef {import('../../github/types.js').GitHubIssue} GitHubIssue
 * @typedef {import('../../github/types.js').GitHubPullRequest} GitHubPullRequest
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

  const parentIssueNumber = createIssueSnapshot(issue).parentIssueNumber;
  if (parentIssueNumber !== undefined) {
    return await blockPreparation(context, issue, {
      reason: [
        `Issue #${issue.number} is already part of parent issue #${parentIssueNumber}.`,
        [
          `Use ${requireOperationCatalogOperationLabelName('issue-implement')} on concrete child issues,`,
          `or ${requireOperationCatalogOperationLabelName('prd-prepare')} on the parent issue.`,
        ].join(' '),
      ].join(' '),
    });
  }

  const branchName = createParentBranchName({
    branchPrefix: context.config.branchPrefix,
    parentNumber: issue.number,
  });
  const pullRequestBody = await createPrdPreparePullRequestBodyForIssue(context, {
    issue,
    branchName,
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
 * @param {{ issue: GitHubIssue, branchName: string }} options
 * @returns {Promise<string>}
 */
export async function createPrdPreparePullRequestBodyForIssue(context, { issue, branchName }) {
  const childPullRequests = await readChildPullRequests(context, { issue });
  return createPrdPreparePullRequestBody({
    issue,
    childPullRequests,
    branchName,
    triggerActor: context.triggerActor,
    modelTier: context.modelTier,
    model: context.model,
  });
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
    labels: [PULL_OPS_STATUS_LABELS.humanRequired],
  });
  await context.githubClient.removeLabelsFromIssue({
    number: issue.number,
    labels: [requireOperationCatalogOperationLabelName('prd-prepare')],
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
  await context.githubClient.removeLabelsFromIssue({
    number: issue.number,
    labels: [PULL_OPS_STATUS_LABELS.humanRequired],
  });
}

/**
 * @param {OperationRunnerContext} context
 * @param {GitHubIssue} issue
 * @returns {Promise<void>}
 */
async function markPreparationPrepared(context, issue) {
  await context.githubClient.removeLabelsFromIssue({
    number: issue.number,
    labels: [
      requireOperationCatalogOperationLabelName('prd-prepare'),
      PULL_OPS_STATUS_LABELS.humanRequired,
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
    labels: [PULL_OPS_STATUS_LABELS.humanRequired],
  });
  await context.githubClient.removeLabelsFromIssue({
    number: issue.number,
    labels: [requireOperationCatalogOperationLabelName('prd-prepare')],
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
 * @param {{ issue: GitHubIssue }} options
 * @returns {Promise<{ issueNumber: number, pullRequest: GitHubPullRequest }[]>}
 */
async function readChildPullRequests(context, { issue }) {
  /** @type {{ issueNumber: number, pullRequest: GitHubPullRequest }[]} */
  const childPullRequests = [];

  for (const childIssue of issue.subIssues) {
    if (childIssue.relationshipSource !== 'native') {
      continue;
    }

    const childBranchName = createIssueBranchName({
      branchPrefix: context.config.branchPrefix,
      parentNumber: issue.number,
      issueNumber: childIssue.number,
    });
    const pullRequest = await findPullRequestByHead(context, childBranchName);
    if (pullRequest !== undefined) {
      childPullRequests.push({
        issueNumber: childIssue.number,
        pullRequest,
      });
    }
  }

  return childPullRequests;
}

/**
 * @param {OperationRunnerContext} context
 * @param {string} headBranch
 * @returns {Promise<GitHubPullRequest | undefined>}
 */
async function findPullRequestByHead(context, headBranch) {
  if (context.githubClient.findPullRequestByHead !== undefined) {
    return await context.githubClient.findPullRequestByHead(headBranch);
  }

  return await context.githubClient.findOpenPullRequestByHead(headBranch);
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
