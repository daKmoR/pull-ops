import { validateOperationOutput } from '../../operation-output/OperationOutput.js';

/**
 * @typedef {import('./output.types.js').AddressedFeedback} AddressedFeedback
 * @typedef {import('./output.types.js').ReasonedFeedback} ReasonedFeedback
 * @typedef {import('./output.types.js').CompletedPrAddressReviewOutput} CompletedPrAddressReviewOutput
 * @typedef {import('./output.types.js').BlockedPrAddressReviewOutput} BlockedPrAddressReviewOutput
 * @typedef {import('./output.types.js').PrAddressReviewOutput} PrAddressReviewOutput
 * @typedef {import('./output.types.js').PrAddressReviewOutputValidationResult} PrAddressReviewOutputValidationResult
 */

/** @type {import('../../operation-output/types.js').OperationOutputContract} */
const ADDRESS_REVIEW_OUTPUT_CONTRACT = {
  required: {
    status: ['addressed', 'blocked'],
    summary: 'string',
  },
};

/**
 * @param {unknown} input
 * @returns {PrAddressReviewOutputValidationResult}
 */
export function validatePrAddressReviewOutput(input) {
  const result = validateOperationOutput(input, ADDRESS_REVIEW_OUTPUT_CONTRACT);
  if (!result.valid) {
    return result;
  }

  const status = /** @type {'addressed' | 'blocked'} */ (result.value.status);
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

  const addressed = readAddressedFeedback(result.value.addressed, 'Operation Output.addressed');
  if (!addressed.valid) {
    return addressed;
  }

  const declined = readReasonedFeedback(result.value.declined, 'Operation Output.declined');
  if (!declined.valid) {
    return declined;
  }

  const deferred = readReasonedFeedback(result.value.deferred, 'Operation Output.deferred');
  if (!deferred.valid) {
    return deferred;
  }

  const changes = readStringArray(result.value.changes, 'Operation Output.changes');
  if (!changes.valid) {
    return changes;
  }

  const testPlan = readStringArray(result.value.testPlan, 'Operation Output.testPlan');
  if (!testPlan.valid) {
    return testPlan;
  }

  const followUps =
    result.value.followUps === undefined
      ? []
      : readStringArray(result.value.followUps, 'Operation Output.followUps');
  if (!Array.isArray(followUps) && !followUps.valid) {
    return followUps;
  }

  return {
    valid: true,
    value: {
      status,
      summary: summary.value,
      addressed: addressed.value,
      declined: declined.value,
      deferred: deferred.value,
      changes: changes.value,
      testPlan: testPlan.value,
      followUps: Array.isArray(followUps) ? followUps : followUps.value,
    },
  };
}

/**
 * @param {unknown} value
 * @param {string} path
 * @returns {{ valid: true, value: AddressedFeedback[] } | { valid: false, reason: string }}
 */
function readAddressedFeedback(value, path) {
  if (!Array.isArray(value)) {
    return invalid(`${path} must be an array.`);
  }

  /** @type {AddressedFeedback[]} */
  const feedback = [];
  for (const [index, item] of value.entries()) {
    if (!isPlainObject(item)) {
      return invalid(`${path}[${index}] must be an object.`);
    }

    const feedbackId = readNonEmptyString(item.feedbackId, `${path}[${index}].feedbackId`);
    if (!feedbackId.valid) {
      return feedbackId;
    }

    const response = readNonEmptyString(item.response, `${path}[${index}].response`);
    if (!response.valid) {
      return response;
    }

    feedback.push({
      feedbackId: feedbackId.value,
      response: response.value,
    });
  }

  return { valid: true, value: feedback };
}

/**
 * @param {unknown} value
 * @param {string} path
 * @returns {{ valid: true, value: ReasonedFeedback[] } | { valid: false, reason: string }}
 */
function readReasonedFeedback(value, path) {
  if (!Array.isArray(value)) {
    return invalid(`${path} must be an array.`);
  }

  /** @type {ReasonedFeedback[]} */
  const feedback = [];
  for (const [index, item] of value.entries()) {
    if (!isPlainObject(item)) {
      return invalid(`${path}[${index}] must be an object.`);
    }

    const feedbackId = readNonEmptyString(item.feedbackId, `${path}[${index}].feedbackId`);
    if (!feedbackId.valid) {
      return feedbackId;
    }

    const reason = readNonEmptyString(item.reason, `${path}[${index}].reason`);
    if (!reason.valid) {
      return reason;
    }

    feedback.push({
      feedbackId: feedbackId.value,
      reason: reason.value,
    });
  }

  return { valid: true, value: feedback };
}

/**
 * @param {unknown} value
 * @param {string} path
 * @returns {{ valid: true, value: string[] } | { valid: false, reason: string }}
 */
function readStringArray(value, path) {
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
