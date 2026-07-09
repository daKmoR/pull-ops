import { updateManagedPrState } from '../../managed-pr/ManagedPrState.js';
import { requireOperationCatalogOperationLabelName } from '../operationCatalog.js';

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
 * @param {GitHubIssueReference[]} [options.tickets]
 * @param {PrFinalizeBodyStatus} [options.status]
 * @returns {string}
 */
export function updatePullRequestBodyForPrFinalize({
  body,
  sourceIssueNumber,
  parentIssueNumber,
  finalizedTreeHash,
  finalizedHeadSha,
  tickets,
  status = 'finalized',
}) {
  let updated = body.trimEnd();
  if (tickets !== undefined) {
    updated = upsertSection(updated, 'Tickets', formatTickets(tickets));
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
    lastOperation: requireOperationCatalogOperationLabelName('pr-finalize'),
  });
}

/**
 * @param {GitHubIssueReference[]} tickets
 * @returns {string}
 */
function formatTickets(tickets) {
  if (tickets.length === 0) {
    return '(none discovered)';
  }

  return tickets
    .map(ticket => {
      const title = ticket.title === undefined ? '(title unavailable)' : ticket.title;
      const state = ticket.state === undefined ? 'state unknown' : ticket.state.toLowerCase();
      return `- #${ticket.number} ${title} (${state})`;
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
