import { createManagedPrStateSection } from '../../managed-pr/ManagedPrState.js';
import {
  getOperationCatalogPackageScriptName,
  requireOperationCatalogOperationLabelName,
} from '../operationCatalog.js';

/**
 * @typedef {import('../../config/types.js').ModelTier} ModelTier
 * @typedef {import('../../github/types.js').GitHubIssue} GitHubIssue
 * @typedef {import('../../github/types.js').GitHubPullRequest} GitHubPullRequest
 */

/**
 * @param {object} options
 * @param {GitHubIssue} options.issue
 * @param {{ issueNumber: number, pullRequest: GitHubPullRequest }[]} options.childPullRequests
 * @param {string} options.branchName
 * @param {string | undefined} options.triggerActor
 * @param {ModelTier} options.modelTier
 * @param {string} options.model
 * @returns {string}
 */
export function createPrdPreparePullRequestBody({
  issue,
  childPullRequests,
  branchName,
  triggerActor,
  modelTier,
  model,
}) {
  const runnerTask = getOperationCatalogPackageScriptName('prd-prepare');
  if (runnerTask === undefined) {
    throw new Error('prd-prepare package script identity is missing from the operation catalog.');
  }

  return [
    createManagedPrStateSection({
      status: 'Draft parent preparation',
      source: {
        kind: 'parentIssue',
        number: issue.number,
      },
      branchName,
      triggerActor,
      runnerTask,
      modelTier,
      model,
      lastOperation: requireOperationCatalogOperationLabelName('prd-prepare'),
    }),
    '',
    '## PullOps Link Summary',
    '',
    ...formatPullOpsLinkSummary({ issue, childPullRequests }),
    '',
    '## Summary',
    '',
    `Prepared an umbrella branch and draft PR for PRD issue #${issue.number}.`,
  ].join('\n');
}

/**
 * @param {{
 *   issue: GitHubIssue,
 *   childPullRequests: { issueNumber: number, pullRequest: GitHubPullRequest }[],
 * }} options
 * @returns {string[]}
 */
function formatPullOpsLinkSummary({ issue, childPullRequests }) {
  const lines = ['Kind: Umbrella PR', `PRD Issue: #${issue.number}`, `Closes: #${issue.number}`];

  if (childPullRequests.length === 0) {
    lines.push('Child PRs: none yet');
    return lines;
  }

  lines.push(
    'Child PRs:',
    ...childPullRequests.map(({ issueNumber, pullRequest }) => {
      return `- #${pullRequest.number} for #${issueNumber}`;
    }),
  );
  return lines;
}
