import { validateOperationOutput } from '../../operation-output/OperationOutput.js';

/**
 * @typedef {import('./output.types.js').ImplementedIssueOutput} ImplementedIssueOutput
 * @typedef {import('./output.types.js').BlockedIssueOutput} BlockedIssueOutput
 * @typedef {import('./output.types.js').IssueImplementOutput} IssueImplementOutput
 * @typedef {import('./output.types.js').IssueImplementOutputValidationResult} IssueImplementOutputValidationResult
 */

/** @type {import('../../operation-output/types.js').OperationOutputContract} */
const IMPLEMENT_ISSUE_OUTPUT_CONTRACT = {
  required: {
    status: ['implemented', 'blocked'],
    summary: 'string',
  },
};

/**
 * @param {unknown} input
 * @returns {IssueImplementOutputValidationResult}
 */
export function validateIssueImplementOutput(input) {
  const result = validateOperationOutput(input, IMPLEMENT_ISSUE_OUTPUT_CONTRACT);
  if (!result.valid) {
    return result;
  }

  const status = /** @type {'implemented' | 'blocked'} */ (result.value.status);
  const summary = /** @type {string} */ (result.value.summary).trim();
  if (summary === '') {
    return invalid('Operation Output.summary must be a non-empty string.');
  }

  if (status === 'blocked') {
    const failureReason =
      typeof result.value.failureReason === 'string' && result.value.failureReason.trim() !== ''
        ? result.value.failureReason.trim()
        : summary;
    return {
      valid: true,
      value: {
        status,
        summary,
        failureReason,
      },
    };
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
      summary,
      changes: changes.value,
      testPlan: testPlan.value,
      followUps: Array.isArray(followUps) ? followUps : followUps.value,
    },
  };
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
 * @param {string} reason
 * @returns {{ valid: false, reason: string }}
 */
function invalid(reason) {
  return { valid: false, reason };
}
