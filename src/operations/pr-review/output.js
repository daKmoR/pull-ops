import { MANAGED_PR_OPERATION_NAMES } from '../../managed-pr/transitionPolicy.js';
import { validateOperationOutput } from '../../operation-output/OperationOutput.js';

/**
 * @typedef {import('./output.types.js').ReviewResultStatus} ReviewResultStatus
 * @typedef {import('./output.types.js').ReviewInlineComment} ReviewInlineComment
 * @typedef {import('./output.types.js').ReviewReply} ReviewReply
 * @typedef {import('./output.types.js').ReviewFollowUpIssueProposal} ReviewFollowUpIssueProposal
 * @typedef {import('./output.types.js').CompletedPrReviewOutput} CompletedPrReviewOutput
 * @typedef {import('./output.types.js').BlockedPrReviewOutput} BlockedPrReviewOutput
 * @typedef {import('./output.types.js').PrReviewOutput} PrReviewOutput
 * @typedef {import('./output.types.js').PrReviewOutputValidationResult} PrReviewOutputValidationResult
 */

/** @type {import('../../operation-output/types.js').OperationOutputContract} */
const REVIEW_PR_OUTPUT_CONTRACT = {
  required: {
    status: ['approved', 'changes_requested', 'blocked'],
    summary: 'string',
  },
};

/**
 * @param {unknown} input
 * @returns {PrReviewOutputValidationResult}
 */
export function validatePrReviewOutput(input) {
  const result = validateOperationOutput(input, REVIEW_PR_OUTPUT_CONTRACT);
  if (!result.valid) {
    return result;
  }

  const status = /** @type {ReviewResultStatus} */ (result.value.status);
  const summary = readNonEmptyString(result.value.summary, 'Operation Output.summary');
  if (!summary.valid) {
    return summary;
  }

  if (status === 'blocked') {
    const failureReason = readNonEmptyString(
      result.value.failureReason,
      'Operation Output.failureReason',
    );
    if (!failureReason.valid) {
      return failureReason;
    }

    return {
      valid: true,
      value: {
        status,
        summary: summary.value,
        failureReason: failureReason.value,
      },
    };
  }

  const comments = readInlineComments(result.value.comments, 'Operation Output.comments');
  if (!comments.valid) {
    return comments;
  }

  const replies = readReplies(result.value.replies, 'Operation Output.replies');
  if (!replies.valid) {
    return replies;
  }

  const directChanges = readOptionalStringArray(
    result.value.directChanges,
    'Operation Output.directChanges',
  );
  if (!directChanges.valid) {
    return directChanges;
  }

  const reviewFollowUpIssues = readReviewFollowUpIssues(
    result.value.reviewFollowUpIssues,
    'Operation Output.reviewFollowUpIssues',
  );
  if (!reviewFollowUpIssues.valid) {
    return reviewFollowUpIssues;
  }

  const followUps = readOptionalStringArray(result.value.followUps, 'Operation Output.followUps');
  if (!followUps.valid) {
    return followUps;
  }

  const nextOperation = readNextOperationProposal(result.value.nextOperation, status);
  if (!nextOperation.valid) {
    return nextOperation;
  }

  return {
    valid: true,
    value: {
      status,
      summary: summary.value,
      ...(nextOperation.value === undefined ? {} : { nextOperation: nextOperation.value }),
      comments: comments.value,
      replies: replies.value,
      directChanges: directChanges.value,
      reviewFollowUpIssues: reviewFollowUpIssues.value,
      followUps: followUps.value,
    },
  };
}

/**
 * A proposal is schema-valid when it names a managed PR workflow operation
 * and rides on a changes_requested review; whether the proposal is an
 * allowed continuation stays with the PullOps-Managed PR Transition Graph.
 *
 * @param {unknown} value
 * @param {ReviewResultStatus} status
 * @returns {{ valid: true, value: string | undefined } | { valid: false, reason: string }}
 */
function readNextOperationProposal(value, status) {
  if (value === undefined) {
    return { valid: true, value: undefined };
  }

  if (status !== 'changes_requested') {
    return {
      valid: false,
      reason: 'Operation Output.nextOperation is only accepted with status "changes_requested".',
    };
  }

  if (
    typeof value !== 'string' ||
    !MANAGED_PR_OPERATION_NAMES.includes(/** @type {never} */ (value))
  ) {
    return {
      valid: false,
      reason: `Operation Output.nextOperation must be one of: ${MANAGED_PR_OPERATION_NAMES.join(', ')}.`,
    };
  }

  return { valid: true, value };
}

/**
 * @param {unknown} value
 * @param {string} path
 * @returns {{ valid: true, value: ReviewFollowUpIssueProposal[] } | { valid: false, reason: string }}
 */
function readReviewFollowUpIssues(value, path) {
  if (value === undefined) {
    return { valid: true, value: [] };
  }

  if (!Array.isArray(value)) {
    return invalid(`${path} must be an array.`);
  }

  /** @type {ReviewFollowUpIssueProposal[]} */
  const proposals = [];
  for (const [index, item] of value.entries()) {
    if (!isPlainObject(item)) {
      return invalid(`${path}[${index}] must be an object.`);
    }

    const title = readNonEmptyString(item.title, `${path}[${index}].title`);
    if (!title.valid) {
      return title;
    }

    const body = readNonEmptyString(item.body, `${path}[${index}].body`);
    if (!body.valid) {
      return body;
    }

    proposals.push({
      title: title.value,
      body: body.value,
    });
  }

  return { valid: true, value: proposals };
}

/**
 * @param {unknown} value
 * @param {string} path
 * @returns {{ valid: true, value: ReviewInlineComment[] } | { valid: false, reason: string }}
 */
function readInlineComments(value, path) {
  if (value === undefined) {
    return { valid: true, value: [] };
  }

  if (!Array.isArray(value)) {
    return invalid(`${path} must be an array.`);
  }

  /** @type {ReviewInlineComment[]} */
  const comments = [];
  for (const [index, item] of value.entries()) {
    if (!isPlainObject(item)) {
      return invalid(`${path}[${index}] must be an object.`);
    }

    const commentPath = readNonEmptyString(item.path, `${path}[${index}].path`);
    if (!commentPath.valid) {
      return commentPath;
    }

    const line = readPositiveInteger(item.line, `${path}[${index}].line`);
    if (!line.valid) {
      return line;
    }

    const body = readNonEmptyString(item.body, `${path}[${index}].body`);
    if (!body.valid) {
      return body;
    }

    comments.push({
      path: commentPath.value,
      line: line.value,
      body: body.value,
    });
  }

  return { valid: true, value: comments };
}

/**
 * @param {unknown} value
 * @param {string} path
 * @returns {{ valid: true, value: ReviewReply[] } | { valid: false, reason: string }}
 */
function readReplies(value, path) {
  if (value === undefined) {
    return { valid: true, value: [] };
  }

  if (!Array.isArray(value)) {
    return invalid(`${path} must be an array.`);
  }

  /** @type {ReviewReply[]} */
  const replies = [];
  for (const [index, item] of value.entries()) {
    if (!isPlainObject(item)) {
      return invalid(`${path}[${index}] must be an object.`);
    }

    const commentId = readPositiveInteger(item.commentId, `${path}[${index}].commentId`);
    if (!commentId.valid) {
      return commentId;
    }

    const body = readNonEmptyString(item.body, `${path}[${index}].body`);
    if (!body.valid) {
      return body;
    }

    replies.push({
      commentId: commentId.value,
      body: body.value,
    });
  }

  return { valid: true, value: replies };
}

/**
 * @param {unknown} value
 * @param {string} path
 * @returns {{ valid: true, value: string[] } | { valid: false, reason: string }}
 */
function readOptionalStringArray(value, path) {
  if (value === undefined) {
    return { valid: true, value: [] };
  }

  if (!Array.isArray(value)) {
    return invalid(`${path} must be an array.`);
  }

  const normalized = value.map(item => (typeof item === 'string' ? item.trim() : item));
  const invalidIndex = normalized.findIndex(item => typeof item !== 'string' || item === '');
  if (invalidIndex !== -1) {
    return invalid(`${path}[${invalidIndex}] must be a non-empty string.`);
  }

  return {
    valid: true,
    value: /** @type {string[]} */ (normalized),
  };
}

/**
 * @param {unknown} value
 * @param {string} path
 * @returns {{ valid: true, value: string } | { valid: false, reason: string }}
 */
function readNonEmptyString(value, path) {
  if (typeof value !== 'string' || value.trim() === '') {
    return invalid(`${path} must be a non-empty string.`);
  }

  return { valid: true, value: value.trim() };
}

/**
 * @param {unknown} value
 * @param {string} path
 * @returns {{ valid: true, value: number } | { valid: false, reason: string }}
 */
function readPositiveInteger(value, path) {
  if (!Number.isInteger(value) || /** @type {number} */ (value) <= 0) {
    return invalid(`${path} must be a positive integer.`);
  }

  return { valid: true, value: /** @type {number} */ (value) };
}

/**
 * @param {string} reason
 * @returns {{ valid: false, reason: string }}
 */
function invalid(reason) {
  return { valid: false, reason };
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
