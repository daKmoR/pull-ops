import { PULL_OPS_OPERATION_LABELS } from '../../labels/pullOpsLabels.js';

/**
 * @typedef {import('./prBody.types.js').ReviewResultStatus} ReviewResultStatus
 * @typedef {import('./prBody.types.js').AddressReviewStatus} AddressReviewStatus
 * @typedef {import('./prBody.types.js').PullOpsPullRequestState} PullOpsPullRequestState
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
    reviewedTreeHash: readMarker(body, 'Reviewed tree:'),
    finalizedTreeHash: readMarker(body, 'Finalized tree:'),
    finalizedHeadSha: readMarker(body, 'Finalized head:'),
    mergeMethod: readMarker(body, 'Merge method:'),
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
 * @param {string} [options.reviewedTreeHash]
 * @returns {string}
 */
export function updatePullRequestBodyForReview({
  body,
  reviewStatus,
  reviewCycle,
  maxReviewCycles,
  reviewedTreeHash,
}) {
  let updated = body.trimEnd();
  updated = upsertLine(updated, 'Status:', formatReviewStatus(reviewStatus));
  updated = upsertLine(updated, 'Review cycles:', `${reviewCycle} / ${maxReviewCycles}`);
  if (reviewStatus === 'approved' && reviewedTreeHash !== undefined) {
    updated = upsertLine(updated, 'Reviewed tree:', reviewedTreeHash);
  } else if (reviewStatus !== 'approved') {
    updated = removeMergePreparationMarkers(updated);
  }
  updated = upsertLine(updated, 'Last operation:', PULL_OPS_OPERATION_LABELS.prReview);
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
export function updatePullRequestBodyForPrAddressReview({
  body,
  addressReviewStatus,
  reviewCycle,
  maxReviewCycles,
}) {
  let updated = body.trimEnd();
  updated = upsertLine(updated, 'Status:', formatAddressReviewStatus(addressReviewStatus));
  updated = upsertLine(updated, 'Review cycles:', `${reviewCycle} / ${maxReviewCycles}`);
  updated = upsertLine(updated, 'Last operation:', PULL_OPS_OPERATION_LABELS.prAddressReview);
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
export function updatePullRequestBodyForPrFixCi({ body, ciFixStatus, ciFixCycle, maxCiFixCycles }) {
  let updated = body.trimEnd();
  updated = upsertLine(updated, 'Status:', formatPrFixCiStatus(ciFixStatus));
  updated = upsertLine(updated, 'CI fix cycles:', `${ciFixCycle} / ${maxCiFixCycles}`);
  updated = upsertLine(updated, 'Last operation:', PULL_OPS_OPERATION_LABELS.prFixCi);
  return `${updated}\n`;
}

/**
 * @param {object} options
 * @param {string} options.body
 * @param {'updated' | 'conflicts' | 'blocked'} options.updateStatus
 * @returns {string}
 */
export function updatePullRequestBodyForPrUpdateBranch({ body, updateStatus }) {
  let updated = body.trimEnd();
  updated = upsertLine(updated, 'Status:', formatPrUpdateBranchStatus(updateStatus));
  updated = removeMergePreparationMarkers(updated);
  updated = upsertLine(updated, 'Last operation:', PULL_OPS_OPERATION_LABELS.prUpdateBranch);
  return `${updated}\n`;
}

/**
 * @param {object} options
 * @param {string} options.body
 * @param {'resolved' | 'blocked'} options.resolveStatus
 * @returns {string}
 */
export function updatePullRequestBodyForPrResolveConflicts({ body, resolveStatus }) {
  let updated = body.trimEnd();
  updated = upsertLine(updated, 'Status:', formatPrResolveConflictsStatus(resolveStatus));
  updated = removeMergePreparationMarkers(updated);
  updated = upsertLine(updated, 'Last operation:', PULL_OPS_OPERATION_LABELS.prResolveConflicts);
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
function formatPrFixCiStatus(status) {
  if (status === 'fixed') {
    return 'CI fixed';
  }

  return 'Blocked';
}

/**
 * @param {'updated' | 'conflicts' | 'blocked'} status
 * @returns {string}
 */
function formatPrUpdateBranchStatus(status) {
  if (status === 'updated') {
    return 'Branch updated';
  }

  if (status === 'conflicts') {
    return 'Rebase conflicts';
  }

  return 'Blocked';
}

/**
 * @param {'resolved' | 'blocked'} status
 * @returns {string}
 */
function formatPrResolveConflictsStatus(status) {
  if (status === 'resolved') {
    return 'Rebase conflicts resolved';
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
  return readMarker(body, 'Last operation:');
}

/**
 * @param {string} body
 * @param {string} prefix
 * @returns {string | undefined}
 */
function readMarker(body, prefix) {
  const pattern = new RegExp(`^${escapeRegExp(prefix)}\\s*(.+?)\\s*$`, 'im');
  const match = body.match(pattern);
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
 * @param {string} body
 * @returns {string}
 */
function removeMergePreparationMarkers(body) {
  let updated = body;
  for (const prefix of ['Reviewed tree:', 'Finalized tree:', 'Finalized head:', 'Merge method:']) {
    updated = removeLine(updated, prefix);
  }
  return updated.trimEnd();
}

/**
 * @param {string} body
 * @param {string} prefix
 * @returns {string}
 */
function removeLine(body, prefix) {
  const pattern = new RegExp(`^${escapeRegExp(prefix)}\\s*.*\\n?`, 'im');
  return body.replace(pattern, '');
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
