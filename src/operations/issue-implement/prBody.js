import { PULL_OPS_OPERATION_LABELS } from '../../labels/pullOpsLabels.js';
import { createManagedPrStateSection } from '../../managed-pr/ManagedPrState.js';

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
  triggerActor,
  modelTier,
  model,
}) {
  return [
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
    '',
    '## Traceability',
    '',
    ...formatIssueTraceability({ issue, parentIssueNumber }),
    ...formatParentTraceability({ issue, parentIssueNumber }),
    '',
    createManagedPrStateSection({
      status: 'Draft automation',
      source: {
        kind: 'issue',
        number: issue.number,
      },
      branchName,
      triggerActor,
      runnerTask: 'pullops-issue-implement',
      modelTier,
      model,
      lastOperation: PULL_OPS_OPERATION_LABELS.issueImplement,
      reviewCycles: {
        current: 0,
        max: 3,
      },
      ciFixCycles: {
        current: 0,
        max: 2,
      },
    }),
  ].join('\n');
}

/**
 * @param {{ issue: GitHubIssue, parentIssueNumber: number | undefined }} options
 * @returns {string[]}
 */
function formatIssueTraceability({ issue, parentIssueNumber }) {
  if (parentIssueNumber === undefined) {
    return [`Closes #${issue.number}`];
  }

  return [`Refs #${issue.number}`];
}

/**
 * @param {{ issue: GitHubIssue, parentIssueNumber: number | undefined }} options
 * @returns {string[]}
 */
function formatParentTraceability({ issue, parentIssueNumber }) {
  const resolvedParentIssueNumber = parentIssueNumber ?? issue.parent?.number;
  if (resolvedParentIssueNumber === undefined) {
    return [];
  }

  return [`Part of #${resolvedParentIssueNumber}`];
}

/**
 * @param {string[]} items
 * @returns {string}
 */
function formatList(items) {
  return items.map(item => `- ${item}`).join('\n');
}
