/**
 * @typedef {import('./types.js').NormalizedPrdIssueRequest} NormalizedPrdIssueRequest
 * @typedef {import('./types.js').PrdIssuePublicationMarker} PrdIssuePublicationMarker
 */

const PULL_OPS_PUBLICATION_MARKER_PREFIX = '<!-- PullOps publication marker: ';
const PULL_OPS_PUBLICATION_MARKER_SUFFIX = ' -->';

/**
 * @param {NormalizedPrdIssueRequest} request
 * @returns {string}
 */
export function createPrdIssueBody(request) {
  const sections = [
    createPublicationMarkerComment({
      schemaVersion: 1,
      provider: 'github',
      kind: 'prd-issue',
    }),
    '',
    '## Problem Statement',
    '',
    request.problemStatement.trim(),
    '',
    '## Solution',
    '',
    request.solution.trim(),
    '',
    '## User Stories',
    '',
    ...[...request.userStories]
      .sort((left, right) => left.number - right.number)
      .map(story => `- ${story.number}. ${story.story.trim()}`),
    '',
    '## Implementation Decisions',
    '',
    ...request.implementationDecisions.map(decision => `- ${decision}`),
    '',
    '## Testing Decisions',
    '',
    ...request.testingDecisions.map(decision => `- ${decision}`),
    '',
    '## Out of Scope',
    '',
    ...request.outOfScope.map(item => `- ${item}`),
  ];

  if (request.furtherNotes.length > 0) {
    sections.push('', '## Further Notes', '', ...request.furtherNotes.map(note => `- ${note}`));
  }

  if (request.auditDetails.length > 0) {
    sections.push('', createPublicationAuditDetails(request.auditDetails));
  }

  return `${sections.join('\n').trimEnd()}\n`;
}

/**
 * @param {string} body
 * @returns {PrdIssuePublicationMarker | undefined}
 */
export function readPrdIssuePublicationMarker(body) {
  const markerText = readPublicationMarkerText(body);
  if (markerText === undefined) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(markerText);
    if (!isPrdIssuePublicationMarker(parsed)) {
      return undefined;
    }

    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * @param {PrdIssuePublicationMarker} marker
 * @returns {string}
 */
function createPublicationMarkerComment(marker) {
  return `${PULL_OPS_PUBLICATION_MARKER_PREFIX}${JSON.stringify(marker)}${PULL_OPS_PUBLICATION_MARKER_SUFFIX}`;
}

/**
 * @param {string[]} auditDetails
 * @returns {string}
 */
function createPublicationAuditDetails(auditDetails) {
  return [
    '<details>',
    '<summary>PullOps publication audit</summary>',
    '',
    ...auditDetails.map(detail => `- ${detail}`),
    '',
    '</details>',
  ].join('\n');
}

/**
 * @param {string} body
 * @returns {string | undefined}
 */
function readPublicationMarkerText(body) {
  const pattern = /<!--\s*PullOps publication marker:\s*([\s\S]*?)\s*-->/i;
  const match = body.match(pattern);
  if (match?.[1] === undefined) {
    return undefined;
  }

  return match[1].trim();
}

/**
 * @param {unknown} value
 * @returns {value is PrdIssuePublicationMarker}
 */
function isPrdIssuePublicationMarker(value) {
  if (!isPlainObject(value)) {
    return false;
  }

  return value.schemaVersion === 1 && value.provider === 'github' && value.kind === 'prd-issue';
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
