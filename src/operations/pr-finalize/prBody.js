import { PULL_OPS_OPERATION_LABELS } from '../../labels/pullOpsLabels.js';
import { updateManagedPrState } from '../../managed-pr/ManagedPrState.js';

/**
 * @typedef {import('../../github/types.js').GitHubIssueReference} GitHubIssueReference
 */

/**
 * @typedef {'finalized' | 'ready'} PrFinalizeBodyStatus
 */

/**
 * @param {object} options
 * @param {string} options.body
 * @param {number} options.sourceIssueNumber
 * @param {number | undefined} options.parentIssueNumber
 * @param {string} options.finalizedTreeHash
 * @param {string} options.finalizedHeadSha
 * @param {GitHubIssueReference[]} [options.childIssues]
 * @param {PrFinalizeBodyStatus} [options.status]
 * @returns {string}
 */
export function updatePullRequestBodyForPrFinalize({
  body,
  sourceIssueNumber,
  parentIssueNumber,
  finalizedTreeHash,
  finalizedHeadSha,
  childIssues,
  status = 'finalized',
}) {
  let updated = body.trimEnd();
  if (childIssues !== undefined) {
    updated = upsertSection(updated, 'Child Issues', formatChildIssues(childIssues));
  }
  updated = upsertSection(
    updated,
    'Traceability',
    formatIssueTraceability({ sourceIssueNumber, parentIssueNumber }).join('\n'),
  );
  return updateManagedPrState({
    body: updated,
    status: formatPrFinalizeStatus(status),
    finalizedTreeHash,
    finalizedHeadSha,
    mergeMethod: 'rebase',
    lastOperation: PULL_OPS_OPERATION_LABELS.prFinalize,
  });
}

/**
 * @param {GitHubIssueReference[]} childIssues
 * @returns {string}
 */
function formatChildIssues(childIssues) {
  if (childIssues.length === 0) {
    return '(none discovered)';
  }

  return childIssues
    .map(childIssue => {
      const title = childIssue.title === undefined ? '(title unavailable)' : childIssue.title;
      const state =
        childIssue.state === undefined ? 'state unknown' : childIssue.state.toLowerCase();
      return `- #${childIssue.number} ${title} (${state})`;
    })
    .join('\n');
}

/**
 * @param {{ sourceIssueNumber: number, parentIssueNumber: number | undefined }} options
 * @returns {string[]}
 */
function formatIssueTraceability({ sourceIssueNumber, parentIssueNumber }) {
  if (parentIssueNumber === undefined) {
    return [`Closes #${sourceIssueNumber}`];
  }

  return [`Refs #${sourceIssueNumber}`, `Part of #${parentIssueNumber}`];
}

/**
 * @param {PrFinalizeBodyStatus} status
 * @returns {string}
 */
function formatPrFinalizeStatus(status) {
  if (status === 'ready') {
    return 'Ready for human merge';
  }

  return 'Finalized for rebase merge';
}

/**
 * @param {string} body
 * @param {string} title
 * @param {string} content
 * @returns {string}
 */
function upsertSection(body, title, content) {
  const heading = `## ${title}`;
  const endOfInput = '(?![\\s\\S])';
  const sectionPattern = new RegExp(
    `(^${escapeRegExp(heading)}\\s*\\n)([\\s\\S]*?)(?=^##\\s+|${endOfInput})`,
    'im',
  );

  if (sectionPattern.test(body)) {
    return body.replace(sectionPattern, () => `${heading}\n\n${content.trim()}\n\n`);
  }

  const pullOpsHeading = /^##\s+PullOps\s*$/im;
  if (pullOpsHeading.test(body)) {
    return body.replace(pullOpsHeading, `${heading}\n\n${content.trim()}\n\n## PullOps`);
  }

  return `${body}\n\n${heading}\n\n${content.trim()}`;
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
