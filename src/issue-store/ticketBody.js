import { createPublicationMarkerComment, readPublicationMarker } from './publicationMarker.js';

/**
 * @typedef {import('./types.js').TicketPublicationMarker} TicketPublicationMarker
 * @typedef {import('./types.js').NormalizedTicketRequest} NormalizedTicketRequest
 */

/**
 * @param {NormalizedTicketRequest & { parentIssueNumber: number }} request
 * @returns {string}
 */
export function createTicketBody(request) {
  const sections = [
    createPublicationMarkerComment({
      schemaVersion: 1,
      provider: 'github',
      kind: 'ticket',
      parentIssueNumber: request.parentIssueNumber,
      sliceRef: request.sliceRef,
    }),
    '',
    '## What to build',
    '',
    request.whatToBuild.trim(),
    '',
    '## Acceptance criteria',
    '',
    ...request.acceptanceCriteria.map(criterion => `- ${criterion}`),
    '',
    '## Blocked by',
    '',
    ...(request.blockedBy.length > 0
      ? request.blockedBy.map(number => `- #${number}`)
      : ['- None.']),
  ];

  if (request.coveredUserStories.length > 0) {
    sections.push(
      '',
      '## Covered Spec user stories',
      '',
      ...request.coveredUserStories.map(number => `- ${number}`),
    );
  } else if (request.supportWork) {
    sections.push(
      '',
      '## Support work',
      '',
      'This Ticket is explicitly marked as support work and does not directly cover Spec user stories.',
    );
  }

  return `${sections.join('\n').trimEnd()}\n`;
}

/**
 * @param {string} body
 * @returns {TicketPublicationMarker | undefined}
 */
export function readTicketPublicationMarker(body) {
  const marker = readPublicationMarker(body);
  if (marker?.kind !== 'ticket') {
    return undefined;
  }

  return marker;
}
