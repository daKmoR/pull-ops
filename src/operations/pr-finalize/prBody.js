import { PULL_OPS_OPERATION_LABELS } from '../../labels/pullOpsLabels.js';

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
  updated = upsertLine(updated, 'Status:', formatPrFinalizeStatus(status));
  updated = upsertLine(updated, 'Finalized tree:', finalizedTreeHash);
  updated = upsertLine(updated, 'Finalized head:', finalizedHeadSha);
  updated = upsertLine(updated, 'Merge method:', 'rebase');
  updated = upsertLine(updated, 'Last operation:', PULL_OPS_OPERATION_LABELS.prFinalize);
  return `${updated}\n`;
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
 * @param {object} options
 * @param {string} options.body
 * @returns {string}
 */
export function updatePullRequestBodyForPrFinalizeFailure({ body }) {
  let updated = body.trimEnd();
  updated = upsertLine(updated, 'Status:', 'Blocked');
  updated = upsertLine(updated, 'Last operation:', PULL_OPS_OPERATION_LABELS.prFinalize);
  return `${updated}\n`;
}

/**
 * @param {object} options
 * @param {string} options.body
 * @returns {string}
 */
export function updatePullRequestBodyForPrFinalizeReroute({ body }) {
  let updated = removeMergePreparationMarkers(body.trimEnd());
  updated = upsertLine(updated, 'Status:', 'Review required');
  updated = upsertLine(updated, 'Last operation:', PULL_OPS_OPERATION_LABELS.prFinalize);
  return `${updated}\n`;
}

/**
 * @param {PrFinalizeBodyStatus} status
 * @returns {string}
 */
function formatPrFinalizeStatus(status) {
  if (status === 'ready') {
    return 'Ready for human rebase merge';
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
  const sectionPattern = new RegExp(
    `(^${escapeRegExp(heading)}\\s*\\n)([\\s\\S]*?)(?=^##\\s+|\\s*$)`,
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
 * @param {string} body
 * @param {string} prefix
 * @param {string} value
 * @returns {string}
 */
function upsertLine(body, prefix, value) {
  const replacement = `${prefix} ${value}`;
  const pattern = new RegExp(`^${escapeRegExp(prefix)}\\s*.*$`, 'im');
  if (pattern.test(body)) {
    return body.replace(pattern, replacement);
  }

  return `${body}\n${replacement}`;
}

/**
 * @param {string} body
 * @returns {string}
 */
function removeMergePreparationMarkers(body) {
  let updated = body;
  for (const prefix of ['Reviewed tree:', 'Finalized tree:', 'Finalized head:', 'Merge method:']) {
    updated = removeLine(updated, prefix);
  }
  return updated.trimEnd();
}

/**
 * @param {string} body
 * @param {string} prefix
 * @returns {string}
 */
function removeLine(body, prefix) {
  const pattern = new RegExp(`^${escapeRegExp(prefix)}\\s*.*\\n?`, 'im');
  return body.replace(pattern, '');
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
