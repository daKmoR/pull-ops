/**
 * @typedef {import('./types.js').ChildIssuePublicationMarker} ChildIssuePublicationMarker
 * @typedef {import('./types.js').ConcreteIssuePublicationMarker} ConcreteIssuePublicationMarker
 * @typedef {import('./types.js').PrdIssuePublicationMarker} PrdIssuePublicationMarker
 * @typedef {import('./types.js').PublicationMarker} PublicationMarker
 */

const PULL_OPS_PUBLICATION_MARKER_PREFIX = '<!-- PullOps publication marker: ';
const PULL_OPS_PUBLICATION_MARKER_SUFFIX = ' -->';

/**
 * @param {PublicationMarker} marker
 * @returns {string}
 */
export function createPublicationMarkerComment(marker) {
  return `${PULL_OPS_PUBLICATION_MARKER_PREFIX}${JSON.stringify(marker)}${PULL_OPS_PUBLICATION_MARKER_SUFFIX}`;
}

/**
 * @param {string} body
 * @returns {PublicationMarker | undefined}
 */
export function readPublicationMarker(body) {
  const markerText = readPublicationMarkerText(body);
  if (markerText === undefined) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(markerText);
    if (!isPublicationMarker(parsed)) {
      return undefined;
    }

    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * @param {string[]} auditDetails
 * @returns {string}
 */
export function createPublicationAuditDetails(auditDetails) {
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
 * @returns {value is PublicationMarker}
 */
function isPublicationMarker(value) {
  if (!isPlainObject(value)) {
    return false;
  }

  if (value.schemaVersion !== 1 || value.provider !== 'github') {
    return false;
  }

  if (value.kind === 'prd-issue' || value.kind === 'concrete-issue') {
    return true;
  }

  if (value.kind === 'child-issue') {
    return (
      typeof value.parentIssueNumber === 'number' &&
      Number.isInteger(value.parentIssueNumber) &&
      value.parentIssueNumber > 0 &&
      typeof value.sliceRef === 'string' &&
      value.sliceRef.trim() !== ''
    );
  }

  return false;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
