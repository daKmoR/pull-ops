import { PULL_OPS_OPERATION_LABELS } from '../../labels/pullOpsLabels.js';

/**
 * @typedef {import('./output.types.js').PreparedPullRequestSections} PreparedPullRequestSections
 */

/**
 * @param {object} options
 * @param {string} options.body
 * @param {PreparedPullRequestSections} options.pullRequest
 * @returns {string}
 */
export function updatePullRequestBodyForPrepareMerge({ body, pullRequest }) {
  let updated = body.trimEnd();
  updated = upsertSection(updated, 'Summary', pullRequest.summary);
  updated = upsertSection(updated, 'Changes', formatList(pullRequest.changes));
  updated = upsertSection(updated, 'Test Plan', formatList(pullRequest.testPlan));
  updated = upsertSection(updated, 'Traceability', pullRequest.traceability.join('\n'));
  updated = upsertLine(updated, 'Status:', 'Prepared for final review');
  updated = upsertLine(updated, 'Last operation:', PULL_OPS_OPERATION_LABELS.prepareMerge);
  return `${updated}\n`;
}

/**
 * @param {object} options
 * @param {string} options.body
 * @returns {string}
 */
export function updatePullRequestBodyForPrepareMergeFailure({ body }) {
  let updated = body.trimEnd();
  updated = upsertLine(updated, 'Status:', 'Blocked');
  updated = upsertLine(updated, 'Last operation:', PULL_OPS_OPERATION_LABELS.prepareMerge);
  return `${updated}\n`;
}

/**
 * @param {string[]} items
 * @returns {string}
 */
function formatList(items) {
  if (items.length === 0) {
    return '(none)';
  }

  return items.map(item => `- ${item}`).join('\n');
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
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
