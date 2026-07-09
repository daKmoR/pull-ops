import {
  createPublicationAuditDetails,
  createPublicationMarkerComment,
  readPublicationMarker,
} from './publicationMarker.js';

/**
 * @typedef {import('./types.js').NormalizedSpecIssueRequest} NormalizedSpecIssueRequest
 * @typedef {import('./types.js').SpecIssuePublicationMarker} SpecIssuePublicationMarker
 */

/**
 * @param {NormalizedSpecIssueRequest} request
 * @returns {string}
 */
export function createSpecIssueBody(request) {
  const sections = [
    createPublicationMarkerComment({
      schemaVersion: 1,
      provider: 'github',
      kind: 'spec-issue',
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
 * @returns {SpecIssuePublicationMarker | undefined}
 */
export function readSpecIssuePublicationMarker(body) {
  const marker = readPublicationMarker(body);
  if (marker?.kind !== 'spec-issue') {
    return undefined;
  }

  return marker;
}
