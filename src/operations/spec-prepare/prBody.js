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
 * @param {{ issueNumber: number, pullRequest: GitHubPullRequest }[]} options.ticketPullRequests
 * @param {string} options.branchName
 * @param {string | undefined} options.triggerActor
 * @param {ModelTier} options.modelTier
 * @param {string} options.model
 * @returns {string}
 */
export function createSpecPreparePullRequestBody({
  issue,
  ticketPullRequests,
  branchName,
  triggerActor,
  modelTier,
  model,
}) {
  const runnerTask = getOperationCatalogPackageScriptName('spec-prepare');
  if (runnerTask === undefined) {
    throw new Error('spec-prepare package script identity is missing from the operation catalog.');
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
      lastOperation: requireOperationCatalogOperationLabelName('spec-prepare'),
    }),
    '',
    '## PullOps Link Summary',
    '',
    ...formatPullOpsLinkSummary({ issue, ticketPullRequests }),
    '',
    '## Summary',
    '',
    `Prepared an umbrella branch and draft PR for Spec issue #${issue.number}.`,
  ].join('\n');
}

/**
 * @param {{
 *   issue: GitHubIssue,
 *   ticketPullRequests: { issueNumber: number, pullRequest: GitHubPullRequest }[],
 * }} options
 * @returns {string[]}
 */
function formatPullOpsLinkSummary({ issue, ticketPullRequests }) {
  const lines = ['Kind: Umbrella PR', `Spec Issue: #${issue.number}`, `Closes: #${issue.number}`];

  if (ticketPullRequests.length === 0) {
    lines.push('Ticket PRs: none yet');
    return lines;
  }

  lines.push(
    'Ticket PRs:',
    ...ticketPullRequests.map(({ issueNumber, pullRequest }) => {
      return `- #${pullRequest.number} for #${issueNumber}`;
    }),
  );
  return lines;
}
