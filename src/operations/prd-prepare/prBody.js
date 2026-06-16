import { PULL_OPS_OPERATION_LABELS } from '../../labels/pullOpsLabels.js';
import { createManagedPrStateSection } from '../../managed-pr/ManagedPrState.js';

/**
 * @typedef {import('../../config/types.js').ModelTier} ModelTier
 * @typedef {import('../../github/types.js').GitHubIssue} GitHubIssue
 */

/**
 * @param {object} options
 * @param {GitHubIssue} options.issue
 * @param {string} options.branchName
 * @param {string | undefined} options.triggerActor
 * @param {ModelTier} options.modelTier
 * @param {string} options.model
 * @returns {string}
 */
export function createPrdPreparePullRequestBody({
  issue,
  branchName,
  triggerActor,
  modelTier,
  model,
}) {
  return [
    '## Summary',
    '',
    `Prepared an umbrella branch and draft PR for parent issue #${issue.number}.`,
    '',
    '## Child Issues',
    '',
    formatChildIssues(issue),
    '',
    '## Traceability',
    '',
    `Closes #${issue.number}`,
    '',
    createManagedPrStateSection({
      status: 'Draft parent preparation',
      source: {
        kind: 'parentIssue',
        number: issue.number,
      },
      branchName,
      triggerActor,
      runnerTask: 'pullops-prd-prepare',
      modelTier,
      model,
      lastOperation: PULL_OPS_OPERATION_LABELS.prdPrepare,
    }),
  ].join('\n');
}

/**
 * @param {GitHubIssue} issue
 * @returns {string}
 */
function formatChildIssues(issue) {
  if (issue.subIssues.length === 0) {
    return '(none discovered)';
  }

  return issue.subIssues
    .map(childIssue => {
      const title = childIssue.title === undefined ? '(title unavailable)' : childIssue.title;
      const state =
        childIssue.state === undefined ? 'state unknown' : childIssue.state.toLowerCase();
      return `- #${childIssue.number} ${title} (${state})`;
    })
    .join('\n');
}
