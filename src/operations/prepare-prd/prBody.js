import { PULL_OPS_OPERATION_LABELS } from '../../labels/pullOpsLabels.js';

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
export function createPreparePrdPullRequestBody({
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
    `Tracks #${issue.number}`,
    '',
    '## PullOps',
    '',
    'Managed PR: yes',
    'Status: Draft parent preparation',
    `Source: Parent Issue #${issue.number}`,
    `Branch: ${branchName}`,
    `Triggered by: ${formatActor(triggerActor)}`,
    'Runner task: pullops-prepare-prd',
    `Model tier: ${modelTier}`,
    `Model: ${model}`,
    `Last operation: ${PULL_OPS_OPERATION_LABELS.preparePrd}`,
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

/**
 * @param {string | undefined} actor
 * @returns {string}
 */
function formatActor(actor) {
  if (actor === undefined || actor.trim() === '') {
    return 'unknown';
  }

  return actor.startsWith('@') ? actor : `@${actor}`;
}
