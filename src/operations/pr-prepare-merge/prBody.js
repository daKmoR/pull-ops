import { PULL_OPS_OPERATION_LABELS } from '../../labels/pullOpsLabels.js';

/**
 * @typedef {'prepared' | 'ready'} PrPrepareMergeBodyStatus
 */

/**
 * @param {object} options
 * @param {string} options.body
 * @param {number} options.sourceIssueNumber
 * @param {string} options.preparedTreeHash
 * @param {string} options.preparedHeadSha
 * @param {PrPrepareMergeBodyStatus} [options.status]
 * @returns {string}
 */
export function updatePullRequestBodyForPrPrepareMerge({
  body,
  sourceIssueNumber,
  preparedTreeHash,
  preparedHeadSha,
  status = 'prepared',
}) {
  let updated = body.trimEnd();
  updated = upsertSection(updated, 'Traceability', `Closes #${sourceIssueNumber}`);
  updated = upsertLine(updated, 'Status:', formatPrepareMergeStatus(status));
  updated = upsertLine(updated, 'Prepared tree:', preparedTreeHash);
  updated = upsertLine(updated, 'Prepared head:', preparedHeadSha);
  updated = upsertLine(updated, 'Merge method:', 'rebase');
  updated = upsertLine(updated, 'Last operation:', PULL_OPS_OPERATION_LABELS.prPrepareMerge);
  return `${updated}\n`;
}

/**
 * @param {object} options
 * @param {string} options.body
 * @returns {string}
 */
export function updatePullRequestBodyForPrPrepareMergeFailure({ body }) {
  let updated = body.trimEnd();
  updated = upsertLine(updated, 'Status:', 'Blocked');
  updated = upsertLine(updated, 'Last operation:', PULL_OPS_OPERATION_LABELS.prPrepareMerge);
  return `${updated}\n`;
}

/**
 * @param {object} options
 * @param {string} options.body
 * @returns {string}
 */
export function updatePullRequestBodyForPrPrepareMergeReroute({ body }) {
  let updated = removeMergePreparationMarkers(body.trimEnd());
  updated = upsertLine(updated, 'Status:', 'Review required');
  updated = upsertLine(updated, 'Last operation:', PULL_OPS_OPERATION_LABELS.prPrepareMerge);
  return `${updated}\n`;
}

/**
 * @param {PrPrepareMergeBodyStatus} status
 * @returns {string}
 */
function formatPrepareMergeStatus(status) {
  if (status === 'ready') {
    return 'Ready for human rebase merge';
  }

  return 'Prepared for rebase merge';
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
  for (const prefix of ['Reviewed tree:', 'Prepared tree:', 'Prepared head:', 'Merge method:']) {
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
