/**
 * @typedef {import('../../config/types.js').ModelTier} ModelTier
 * @typedef {import('../../github/types.js').GitHubIssue} GitHubIssue
 * @typedef {import('./output.js').ImplementedIssueOutput} ImplementedIssueOutput
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
export function createImplementIssuePullRequestBody({
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
    `Closes #${issue.number}`,
    ...formatParentTraceability({ issue, parentIssueNumber }),
    '',
    '## PullOps',
    '',
    'Managed PR: yes',
    'Status: Draft automation',
    'Review cycles: 0 / 3',
    'CI fix cycles: 0 / 2',
    `Source: Issue #${issue.number}`,
    `Branch: ${branchName}`,
    `Triggered by: ${formatActor(triggerActor)}`,
    'Runner task: pullops-implement-issue',
    `Model tier: ${modelTier}`,
    `Model: ${model}`,
    'Last operation: pullops:implement',
  ].join('\n');
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

  return [`PRD: #${resolvedParentIssueNumber}`];
}

/**
 * @param {string[]} items
 * @returns {string}
 */
function formatList(items) {
  return items.map(item => `- ${item}`).join('\n');
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
