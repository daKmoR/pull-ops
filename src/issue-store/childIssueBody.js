/**
 * @typedef {import('./types.js').ChildIssuePublicationMarker} ChildIssuePublicationMarker
 * @typedef {import('./types.js').NormalizedChildIssueRequest} NormalizedChildIssueRequest
 */

const PULL_OPS_PUBLICATION_MARKER_PREFIX = '<!-- PullOps publication marker: ';
const PULL_OPS_PUBLICATION_MARKER_SUFFIX = ' -->';

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
  const markerText = readPublicationMarkerText(body);
  if (markerText === undefined) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(markerText);
    if (!isChildIssuePublicationMarker(parsed)) {
      return undefined;
    }

    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * @param {ChildIssuePublicationMarker} marker
 * @returns {string}
 */
function createPublicationMarkerComment(marker) {
  return `${PULL_OPS_PUBLICATION_MARKER_PREFIX}${JSON.stringify(marker)}${PULL_OPS_PUBLICATION_MARKER_SUFFIX}`;
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
 * @returns {value is ChildIssuePublicationMarker}
 */
function isChildIssuePublicationMarker(value) {
  if (!isPlainObject(value)) {
    return false;
  }

  return (
    value.schemaVersion === 1 &&
    value.provider === 'github' &&
    value.kind === 'child-issue' &&
    typeof value.parentIssueNumber === 'number' &&
    Number.isInteger(value.parentIssueNumber) &&
    value.parentIssueNumber > 0 &&
    typeof value.sliceRef === 'string' &&
    value.sliceRef.trim() !== ''
  );
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
