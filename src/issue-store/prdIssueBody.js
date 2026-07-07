import {
  createPublicationAuditDetails,
  createPublicationMarkerComment,
  readPublicationMarker,
} from './publicationMarker.js';

/**
 * @typedef {import('./types.js').NormalizedPrdIssueRequest} NormalizedPrdIssueRequest
 * @typedef {import('./types.js').PrdIssuePublicationMarker} PrdIssuePublicationMarker
 */

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
  const marker = readPublicationMarker(body);
  if (marker?.kind !== 'prd-issue') {
    return undefined;
  }

  return marker;
}
