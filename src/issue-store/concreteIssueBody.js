import {
  createPublicationAuditDetails,
  createPublicationMarkerComment,
  readPublicationMarker,
} from './publicationMarker.js';

/**
 * @typedef {import('./types.js').ConcreteIssuePublicationMarker} ConcreteIssuePublicationMarker
 * @typedef {import('./types.js').NormalizedConcreteIssueRequest} NormalizedConcreteIssueRequest
 */

/**
 * @param {NormalizedConcreteIssueRequest} request
 * @returns {string}
 */
export function createConcreteIssueBody(request) {
  const sections = [
    createPublicationMarkerComment({
      schemaVersion: 1,
      provider: 'github',
      kind: 'concrete-issue',
    }),
    '',
    '## What to build',
    '',
    request.whatToBuild.trim(),
    '',
    '## Acceptance criteria',
    '',
    ...request.acceptanceCriteria.map(criterion => `- ${criterion}`),
  ];

  if (request.blockedBy.length > 0) {
    sections.push('', '## Blocked by', '', ...request.blockedBy.map(number => `- #${number}`));
  }

  const auditDetails = request.auditDetails ?? [];
  if (auditDetails.length > 0) {
    sections.push('', createPublicationAuditDetails(auditDetails));
  }

  return `${sections.join('\n').trimEnd()}\n`;
}

/**
 * @param {string} body
 * @returns {ConcreteIssuePublicationMarker | undefined}
 */
export function readConcreteIssuePublicationMarker(body) {
  const marker = readPublicationMarker(body);
  if (marker?.kind !== 'concrete-issue') {
    return undefined;
  }

  return marker;
}
