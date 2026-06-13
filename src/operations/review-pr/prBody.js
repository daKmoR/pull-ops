import { PULL_OPS_OPERATION_LABELS } from '../../labels/pullOpsLabels.js';

/**
 * @typedef {import('./output.js').ReviewResultStatus} ReviewResultStatus
 * @typedef {'addressed' | 'blocked'} AddressReviewStatus
 * @typedef {{
 *   managed: boolean;
 *   sourceIssueNumber?: number;
 *   reviewCycles: {
 *     current: number;
 *     max: number;
 *   };
 * }} PullOpsPullRequestState
 */

export const DEFAULT_MAX_REVIEW_CYCLES = 3;

/**
 * @param {string} body
 * @returns {PullOpsPullRequestState}
 */
export function readPullOpsPullRequestState(body) {
  return {
    managed: /^Managed PR:\s*yes\s*$/im.test(body),
    sourceIssueNumber: readSourceIssueNumber(body),
    reviewCycles: readReviewCycles(body),
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
 * @param {string} body
 * @returns {number | undefined}
 */
function readSourceIssueNumber(body) {
  const sourceMatch = body.match(/^Source:\s*Issue\s+#(\d+)\s*$/im);
  if (sourceMatch?.[1] !== undefined) {
    return Number(sourceMatch[1]);
  }

  const closesMatch = body.match(/^Closes\s+#(\d+)\s*$/im);
  if (closesMatch?.[1] !== undefined) {
    return Number(closesMatch[1]);
  }

  return undefined;
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
