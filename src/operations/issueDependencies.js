import { PULL_OPS_STATUS_LABELS } from '../labels/pullOpsLabels.js';

/**
 * @typedef {import('../github/types.js').GitHubIssue} GitHubIssue
 */

/**
 * @param {string} body
 * @returns {{ partOf: number | undefined, blockedBy: number[] }}
 */
export function parseIssueDependencies(body) {
  return {
    partOf: parseFirstIssueReference(body, 'Part of'),
    blockedBy: parseIssueReferenceList(body, 'Blocked by'),
  };
}

/**
 * @param {GitHubIssue} issue
 * @returns {number | undefined}
 */
export function getParentIssueNumber(issue) {
  return issue.parent?.number ?? parseIssueDependencies(issue.body).partOf;
}

/**
 * @param {GitHubIssue} issue
 * @returns {boolean}
 */
export function isIssueDone(issue) {
  return issue.state === 'CLOSED' || issue.labels.includes(PULL_OPS_STATUS_LABELS.done);
}

/**
 * @param {string} body
 * @param {string} fieldName
 * @returns {number | undefined}
 */
function parseFirstIssueReference(body, fieldName) {
  return parseIssueReferenceList(body, fieldName)[0];
}

/**
 * @param {string} body
 * @param {string} fieldName
 * @returns {number[]}
 */
function parseIssueReferenceList(body, fieldName) {
  const linePattern = new RegExp(`^\\s*${escapeRegExp(fieldName)}\\s*:\\s*(.+)$`, 'im');
  const match = linePattern.exec(body);
  if (match === null) {
    return [];
  }

  const references = match[1].match(/#(\d+)/g) ?? [];
  return [...new Set(references.map(reference => Number(reference.slice(1))))];
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
