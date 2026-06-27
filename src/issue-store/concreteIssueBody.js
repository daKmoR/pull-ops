/**
 * @typedef {import('./types.js').ConcreteIssuePublicationMarker} ConcreteIssuePublicationMarker
 * @typedef {import('./types.js').NormalizedConcreteIssueRequest} NormalizedConcreteIssueRequest
 */

const PULL_OPS_PUBLICATION_MARKER_PREFIX = '<!-- PullOps publication marker: ';
const PULL_OPS_PUBLICATION_MARKER_SUFFIX = ' -->';

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

  return `${sections.join('\n').trimEnd()}\n`;
}

/**
 * @param {string} body
 * @returns {ConcreteIssuePublicationMarker | undefined}
 */
export function readConcreteIssuePublicationMarker(body) {
  const markerText = readPublicationMarkerText(body);
  if (markerText === undefined) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(markerText);
    if (!isConcreteIssuePublicationMarker(parsed)) {
      return undefined;
    }

    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * @param {ConcreteIssuePublicationMarker} marker
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
 * @returns {value is ConcreteIssuePublicationMarker}
 */
function isConcreteIssuePublicationMarker(value) {
  if (!isPlainObject(value)) {
    return false;
  }

  return (
    value.schemaVersion === 1 && value.provider === 'github' && value.kind === 'concrete-issue'
  );
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
