import { validateOperationOutput } from '../../operation-output/OperationOutput.js';

/**
 * @typedef {import('./output.types.js').CheckFailureClassification} CheckFailureClassification
 * @typedef {import('./output.types.js').PrFixCiOutputClassification} PrFixCiOutputClassification
 * @typedef {import('./output.types.js').PrFixCiSafetyChecks} PrFixCiSafetyChecks
 * @typedef {import('./output.types.js').CompletedPrFixCiOutput} CompletedPrFixCiOutput
 * @typedef {import('./output.types.js').BlockedPrFixCiOutput} BlockedPrFixCiOutput
 * @typedef {import('./output.types.js').PrFixCiOutput} PrFixCiOutput
 * @typedef {import('./output.types.js').PrFixCiOutputValidationResult} PrFixCiOutputValidationResult
 */

/**
 * The classifications PullOps accepts repairs for. Everything else blocks:
 * environment, flaky, and secret failures are not code-actionable.
 *
 * @type {CheckFailureClassification[]}
 */
export const ACTIONABLE_CHECK_FAILURE_CLASSIFICATIONS = [
  'formatting',
  'lint',
  'type',
  'test',
  'build',
];

/** @type {CheckFailureClassification[]} */
const CHECK_FAILURE_CLASSIFICATIONS = [
  ...ACTIONABLE_CHECK_FAILURE_CLASSIFICATIONS,
  'environment',
  'flaky',
  'secret',
];

/** @type {import('../../operation-output/types.js').OperationOutputContract} */
const FIX_CI_OUTPUT_CONTRACT = {
  required: {
    status: ['fixed', 'blocked'],
    summary: 'string',
  },
};

/**
 * @param {unknown} input
 * @returns {PrFixCiOutputValidationResult}
 */
export function validatePrFixCiOutput(input) {
  const result = validateOperationOutput(input, FIX_CI_OUTPUT_CONTRACT);
  if (!result.valid) {
    return result;
  }

  const status = /** @type {'fixed' | 'blocked'} */ (result.value.status);
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

    const blockedClassifications =
      result.value.classifications === undefined
        ? undefined
        : readOutputClassifications(
            result.value.classifications,
            'Operation Output.classifications',
          );
    if (blockedClassifications !== undefined && !blockedClassifications.valid) {
      return blockedClassifications;
    }

    return {
      valid: true,
      value: {
        status,
        summary: summary.value,
        failureReason: failureReason.value,
        ...(blockedClassifications === undefined
          ? {}
          : { classifications: blockedClassifications.value }),
      },
    };
  }

  const classifications = readOutputClassifications(
    result.value.classifications,
    'Operation Output.classifications',
  );
  if (!classifications.valid) {
    return classifications;
  }

  const safetyChecks = readSafetyChecks(result.value.safetyChecks, 'Operation Output.safetyChecks');
  if (!safetyChecks.valid) {
    return safetyChecks;
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
      classifications: classifications.value,
      safetyChecks: safetyChecks.value,
      changes: changes.value,
      testPlan: testPlan.value,
      followUps: Array.isArray(followUps) ? followUps : followUps.value,
    },
  };
}

/**
 * @param {unknown} value
 * @param {string} path
 * @returns {{ valid: true, value: PrFixCiOutputClassification[] } | { valid: false, reason: string }}
 */
function readOutputClassifications(value, path) {
  if (!Array.isArray(value)) {
    return invalid(`${path} must be an array.`);
  }

  /** @type {PrFixCiOutputClassification[]} */
  const classifications = [];
  for (const [index, item] of value.entries()) {
    if (!isPlainObject(item)) {
      return invalid(`${path}[${index}] must be an object.`);
    }

    const checkId = readNonEmptyString(item.checkId, `${path}[${index}].checkId`);
    if (!checkId.valid) {
      return checkId;
    }

    if (
      !CHECK_FAILURE_CLASSIFICATIONS.includes(
        /** @type {CheckFailureClassification} */ (item.classification),
      )
    ) {
      return invalid(
        `${path}[${index}].classification must be one of: ${CHECK_FAILURE_CLASSIFICATIONS.join(
          ', ',
        )}.`,
      );
    }

    const rationale = readNonEmptyString(item.rationale, `${path}[${index}].rationale`);
    if (!rationale.valid) {
      return rationale;
    }

    classifications.push({
      checkId: checkId.value,
      classification: /** @type {CheckFailureClassification} */ (item.classification),
      rationale: rationale.value,
    });
  }

  return { valid: true, value: classifications };
}

/**
 * @param {unknown} value
 * @param {string} path
 * @returns {{ valid: true, value: PrFixCiSafetyChecks } | { valid: false, reason: string }}
 */
function readSafetyChecks(value, path) {
  if (!isPlainObject(value)) {
    return invalid(`${path} must be an object.`);
  }

  const weakenedTests = readBoolean(value.weakenedTests, `${path}.weakenedTests`);
  if (!weakenedTests.valid) {
    return weakenedTests;
  }

  const deletedAssertions = readBoolean(value.deletedAssertions, `${path}.deletedAssertions`);
  if (!deletedAssertions.valid) {
    return deletedAssertions;
  }

  const bypassedChecks = readBoolean(value.bypassedChecks, `${path}.bypassedChecks`);
  if (!bypassedChecks.valid) {
    return bypassedChecks;
  }

  const secretOrInfrastructureWorkaround = readBoolean(
    value.secretOrInfrastructureWorkaround,
    `${path}.secretOrInfrastructureWorkaround`,
  );
  if (!secretOrInfrastructureWorkaround.valid) {
    return secretOrInfrastructureWorkaround;
  }

  return {
    valid: true,
    value: {
      weakenedTests: weakenedTests.value,
      deletedAssertions: deletedAssertions.value,
      bypassedChecks: bypassedChecks.value,
      secretOrInfrastructureWorkaround: secretOrInfrastructureWorkaround.value,
    },
  };
}

/**
 * @param {unknown} value
 * @param {string} path
 * @returns {{ valid: true, value: boolean } | { valid: false, reason: string }}
 */
function readBoolean(value, path) {
  if (typeof value !== 'boolean') {
    return invalid(`${path} must be a boolean.`);
  }

  return { valid: true, value };
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
