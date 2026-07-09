import { createManagedPrStateSection } from '../../managed-pr/ManagedPrState.js';
import {
  getOperationCatalogPackageScriptName,
  requireOperationCatalogOperationLabelName,
} from '../operationCatalog.js';

/**
 * @typedef {import('../../config/types.js').ModelTier} ModelTier
 * @typedef {import('../../github/types.js').GitHubIssue} GitHubIssue
 * @typedef {import('./output.types.js').ImplementedIssueOutput} ImplementedIssueOutput
 */

/**
 * @param {object} options
 * @param {GitHubIssue} options.issue
 * @param {ImplementedIssueOutput} options.output
 * @param {string} options.branchName
 * @param {number | undefined} options.parentIssueNumber
 * @param {number | undefined} options.umbrellaPullRequestNumber
 * @param {string | undefined} options.triggerActor
 * @param {ModelTier} options.modelTier
 * @param {string} options.model
 * @returns {string}
 */
export function createIssueImplementPullRequestBody({
  issue,
  output,
  branchName,
  parentIssueNumber,
  umbrellaPullRequestNumber,
  triggerActor,
  modelTier,
  model,
}) {
  const runnerTask = getOperationCatalogPackageScriptName('issue-implement');
  if (runnerTask === undefined) {
    throw new Error(
      'issue-implement package script identity is missing from the operation catalog.',
    );
  }

  return [
    createManagedPrStateSection({
      status: 'Draft automation',
      source: {
        kind: 'issue',
        number: issue.number,
      },
      branchName,
      triggerActor,
      runnerTask,
      modelTier,
      model,
      lastOperation: requireOperationCatalogOperationLabelName('issue-implement'),
      reviewCycles: {
        current: 0,
        max: 3,
      },
      ciFixCycles: {
        current: 0,
        max: 2,
      },
    }),
    '',
    '## PullOps Link Summary',
    '',
    ...formatPullOpsLinkSummary({
      issue,
      parentIssueNumber,
      umbrellaPullRequestNumber,
    }),
    '',
    '## Summary',
    '',
    output.summary,
    '',
    '## Changes',
    '',
    formatList(output.changes),
    '',
    '## Test Plan',
    '',
    formatList(output.testPlan),
  ].join('\n');
}

/**
 * @param {{
 *   issue: GitHubIssue,
 *   parentIssueNumber: number | undefined,
 *   umbrellaPullRequestNumber: number | undefined,
 * }} options
 * @returns {string[]}
 */
function formatPullOpsLinkSummary({ issue, parentIssueNumber, umbrellaPullRequestNumber }) {
  if (parentIssueNumber === undefined) {
    return [
      'Kind: Concrete Issue PR',
      `Source Issue: #${issue.number}`,
      `Closes: #${issue.number}`,
    ];
  }

  return [
    'Kind: Ticket PR',
    `Source Issue: #${issue.number}`,
    umbrellaPullRequestNumber === undefined
      ? 'Umbrella PR: pending'
      : `Umbrella PR: #${umbrellaPullRequestNumber}`,
  ];
}

/**
 * @param {string[]} items
 * @returns {string}
 */
function formatList(items) {
  return items.map(item => `- ${item}`).join('\n');
}
