import { validateOperationOutput } from '../../operation-output/OperationOutput.js';

/**
 * @typedef {import('./output.types.js').PrResolveConflictsOutput} PrResolveConflictsOutput
 * @typedef {import('./output.types.js').PrResolveConflictsOutputValidationResult} PrResolveConflictsOutputValidationResult
 */

/** @type {import('../../operation-output/types.js').OperationOutputContract} */
const RESOLVE_CONFLICTS_OUTPUT_CONTRACT = {
  required: {
    status: ['resolved', 'blocked'],
    summary: 'string',
  },
};

/**
 * @param {unknown} input
 * @returns {PrResolveConflictsOutputValidationResult}
 */
export function validatePrResolveConflictsOutput(input) {
  const result = validateOperationOutput(input, RESOLVE_CONFLICTS_OUTPUT_CONTRACT);
  if (!result.valid) {
    return result;
  }

  const status = /** @type {'resolved' | 'blocked'} */ (result.value.status);
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

  const resolvedFiles = readStringArray(
    result.value.resolvedFiles,
    'Operation Output.resolvedFiles',
  );
  if (!resolvedFiles.valid) {
    return resolvedFiles;
  }

  const changes = readStringArray(result.value.changes, 'Operation Output.changes');
  if (!changes.valid) {
    return changes;
  }

  const testPlan = readStringArray(result.value.testPlan, 'Operation Output.testPlan');
  if (!testPlan.valid) {
    return testPlan;
  }

  const followUps = readOptionalStringArray(result.value.followUps, 'Operation Output.followUps');
  if (!followUps.valid) {
    return followUps;
  }

  return {
    valid: true,
    value: {
      status,
      summary: summary.value,
      resolvedFiles: resolvedFiles.value,
      changes: changes.value,
      testPlan: testPlan.value,
      followUps: followUps.value,
    },
  };
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

  return readStringArray(value, path);
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
