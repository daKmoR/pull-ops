import { PULL_OPS_OPERATION_LABELS } from '../../labels/pullOpsLabels.js';

/**
 * @typedef {import('./output.js').ReviewResultStatus} ReviewResultStatus
 * @typedef {'addressed' | 'blocked'} AddressReviewStatus
 * @typedef {{
 *   managed: boolean;
 *   sourceIssueNumber?: number;
 *   sourceKind?: 'issue' | 'parentIssue';
 *   lastOperation?: string;
 *   reviewCycles: {
 *     current: number;
 *     max: number;
 *   };
 *   ciFixCycles: {
 *     current: number;
 *     max: number;
 *   };
 * }} PullOpsPullRequestState
 */

export const DEFAULT_MAX_REVIEW_CYCLES = 3;
export const DEFAULT_MAX_CI_FIX_CYCLES = 2;

/**
 * @param {string} body
 * @returns {PullOpsPullRequestState}
 */
export function readPullOpsPullRequestState(body) {
  const source = readSource(body);

  return {
    managed: /^Managed PR:\s*yes\s*$/im.test(body),
    ...(source === undefined
      ? {}
      : {
          sourceIssueNumber: source.number,
          sourceKind: source.kind,
        }),
    lastOperation: readLastOperation(body),
    reviewCycles: readReviewCycles(body),
    ciFixCycles: readCiFixCycles(body),
  };
}

/**
 * @param {object} options
 * @param {string} options.body
 * @param {ReviewResultStatus} options.reviewStatus
 * @param {number} options.reviewCycle
 * @param {number} options.maxReviewCycles
 * @returns {string}
 */
export function updatePullRequestBodyForReview({
  body,
  reviewStatus,
  reviewCycle,
  maxReviewCycles,
}) {
  let updated = body.trimEnd();
  updated = upsertLine(updated, 'Status:', formatReviewStatus(reviewStatus));
  updated = upsertLine(updated, 'Review cycles:', `${reviewCycle} / ${maxReviewCycles}`);
  updated = upsertLine(updated, 'Last operation:', PULL_OPS_OPERATION_LABELS.reviewPr);
  return `${updated}\n`;
}

/**
 * @param {object} options
 * @param {string} options.body
 * @param {AddressReviewStatus} options.addressReviewStatus
 * @param {number} options.reviewCycle
 * @param {number} options.maxReviewCycles
 * @returns {string}
 */
export function updatePullRequestBodyForAddressReview({
  body,
  addressReviewStatus,
  reviewCycle,
  maxReviewCycles,
}) {
  let updated = body.trimEnd();
  updated = upsertLine(updated, 'Status:', formatAddressReviewStatus(addressReviewStatus));
  updated = upsertLine(updated, 'Review cycles:', `${reviewCycle} / ${maxReviewCycles}`);
  updated = upsertLine(updated, 'Last operation:', PULL_OPS_OPERATION_LABELS.addressReview);
  return `${updated}\n`;
}

/**
 * @param {object} options
 * @param {string} options.body
 * @param {'fixed' | 'blocked'} options.ciFixStatus
 * @param {number} options.ciFixCycle
 * @param {number} options.maxCiFixCycles
 * @returns {string}
 */
export function updatePullRequestBodyForFixCi({ body, ciFixStatus, ciFixCycle, maxCiFixCycles }) {
  let updated = body.trimEnd();
  updated = upsertLine(updated, 'Status:', formatFixCiStatus(ciFixStatus));
  updated = upsertLine(updated, 'CI fix cycles:', `${ciFixCycle} / ${maxCiFixCycles}`);
  updated = upsertLine(updated, 'Last operation:', PULL_OPS_OPERATION_LABELS.fixCi);
  return `${updated}\n`;
}

/**
 * @param {ReviewResultStatus} status
 * @returns {string}
 */
function formatReviewStatus(status) {
  if (status === 'approved') {
    return 'Review approved';
  }

  if (status === 'changes_requested') {
    return 'Changes requested';
  }

  return 'Blocked';
}

/**
 * @param {AddressReviewStatus} status
 * @returns {string}
 */
function formatAddressReviewStatus(status) {
  if (status === 'addressed') {
    return 'Review feedback addressed';
  }

  return 'Blocked';
}

/**
 * @param {'fixed' | 'blocked'} status
 * @returns {string}
 */
function formatFixCiStatus(status) {
  if (status === 'fixed') {
    return 'CI fixed';
  }

  return 'Blocked';
}

/**
 * @param {string} body
 * @returns {{ number: number, kind: 'issue' | 'parentIssue' } | undefined}
 */
function readSource(body) {
  const sourceMatch = body.match(/^Source:\s*(Parent\s+)?Issue\s+#(\d+)\s*$/im);
  if (sourceMatch?.[2] !== undefined) {
    return {
      number: Number(sourceMatch[2]),
      kind: sourceMatch[1] === undefined ? 'issue' : 'parentIssue',
    };
  }

  const closesMatch = body.match(/^Closes\s+#(\d+)\s*$/im);
  if (closesMatch?.[1] !== undefined) {
    return {
      number: Number(closesMatch[1]),
      kind: 'issue',
    };
  }

  return undefined;
}

/**
 * @param {string} body
 * @returns {string | undefined}
 */
function readLastOperation(body) {
  const match = body.match(/^Last operation:\s*(.+?)\s*$/im);
  return match?.[1]?.trim();
}

/**
 * @param {string} body
 * @returns {{ current: number, max: number }}
 */
function readReviewCycles(body) {
  const match = body.match(/^Review cycles:\s*(\d+)\s*\/\s*(\d+)\s*$/im);
  if (match?.[1] === undefined || match[2] === undefined) {
    return {
      current: 0,
      max: DEFAULT_MAX_REVIEW_CYCLES,
    };
  }

  return {
    current: Number(match[1]),
    max: Number(match[2]),
  };
}

/**
 * @param {string} body
 * @returns {{ current: number, max: number }}
 */
function readCiFixCycles(body) {
  const match = body.match(/^CI fix cycles:\s*(\d+)\s*\/\s*(\d+)\s*$/im);
  if (match?.[1] === undefined || match[2] === undefined) {
    return {
      current: 0,
      max: DEFAULT_MAX_CI_FIX_CYCLES,
    };
  }

  return {
    current: Number(match[1]),
    max: Number(match[2]),
  };
}

/**
 * @param {string} body
 * @param {string} prefix
 * @param {string} value
 * @returns {string}
 */
function upsertLine(body, prefix, value) {
  const replacement = `${prefix} ${value}`;
  const pattern = new RegExp(`^${escapeRegExp(prefix)}\\s*.*$`, 'im');
  if (pattern.test(body)) {
    return body.replace(pattern, replacement);
  }

  return `${body}\n${replacement}`;
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
