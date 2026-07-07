import { readPublicationMarker } from './publicationMarker.js';

/**
 * @typedef {import('../github/types.js').GitHubIssue} GitHubIssue
 * @typedef {import('./types.js').IssueSnapshot} IssueSnapshot
 */

/**
 * Builds an Issue Snapshot: the PullOps-shaped point-in-time read of one issue,
 * carrying its kind, parent, Issue Dependencies, and publication ownership.
 *
 * @param {GitHubIssue} issue
 * @returns {IssueSnapshot}
 */
export function createIssueSnapshot(issue) {
  const marker = readPublicationMarker(issue.body);
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    url: issue.url,
    state: issue.state,
    labels: issue.labels,
    kind: marker?.kind,
    publishedByPullOps: marker !== undefined,
    marker,
    parentIssueNumber: issue.parent?.number,
    childIssueNumbers: issue.subIssues.map(subIssue => subIssue.number),
    blockedBy: parseBlockingIssueReferences(issue.body),
    isDone: issue.state === 'CLOSED',
  };
}

/**
 * @param {string} body
 * @returns {number[]}
 */
function parseBlockingIssueReferences(body) {
  return uniqueNumbers([
    ...parseIssueReferenceList(body, 'Blocked by'),
    ...parseIssueReferenceSection(body, 'Blocked by'),
  ]);
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

  return uniqueNumbers(parseIssueReferences(match[1]));
}

/**
 * @param {string} body
 * @param {string} fieldName
 * @returns {number[]}
 */
function parseIssueReferenceSection(body, fieldName) {
  const lines = body.split(/\r?\n/);
  /** @type {number[]} */
  const references = [];
  let inSection = false;

  for (const line of lines) {
    const heading = parseMarkdownHeading(line);
    if (heading !== undefined) {
      if (inSection) {
        break;
      }

      inSection = heading.toLowerCase() === fieldName.toLowerCase();
      continue;
    }

    if (inSection) {
      references.push(...parseIssueReferences(line));
    }
  }

  return uniqueNumbers(references);
}

/**
 * @param {string} line
 * @returns {string | undefined}
 */
function parseMarkdownHeading(line) {
  const match = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
  return match?.[1].trim();
}

/**
 * @param {string} value
 * @returns {number[]}
 */
function parseIssueReferences(value) {
  const references = value.match(/#(\d+)/g) ?? [];
  return references.map(reference => Number(reference.slice(1)));
}

/**
 * @param {number[]} values
 * @returns {number[]}
 */
function uniqueNumbers(values) {
  return [...new Set(values)];
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
