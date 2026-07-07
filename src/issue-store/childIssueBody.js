import { createPublicationMarkerComment, readPublicationMarker } from './publicationMarker.js';

/**
 * @typedef {import('./types.js').ChildIssuePublicationMarker} ChildIssuePublicationMarker
 * @typedef {import('./types.js').NormalizedChildIssueRequest} NormalizedChildIssueRequest
 */

/**
 * @param {NormalizedChildIssueRequest & { parentIssueNumber: number }} request
 * @returns {string}
 */
export function createChildIssueBody(request) {
  const sections = [
    createPublicationMarkerComment({
      schemaVersion: 1,
      provider: 'github',
      kind: 'child-issue',
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
      '## Covered PRD user stories',
      '',
      ...request.coveredUserStories.map(number => `- ${number}`),
    );
  } else if (request.supportWork) {
    sections.push(
      '',
      '## Support work',
      '',
      'This Child Issue is explicitly marked as support work and does not directly cover PRD user stories.',
    );
  }

  return `${sections.join('\n').trimEnd()}\n`;
}

/**
 * @param {string} body
 * @returns {ChildIssuePublicationMarker | undefined}
 */
export function readChildIssuePublicationMarker(body) {
  const marker = readPublicationMarker(body);
  if (marker?.kind !== 'child-issue') {
    return undefined;
  }

  return marker;
}
