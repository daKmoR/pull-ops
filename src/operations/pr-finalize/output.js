import { validateOperationOutput } from '../../operation-output/OperationOutput.js';

/**
 * @typedef {import('./output.types.js').PlannedCommit} PlannedCommit
 * @typedef {import('./output.types.js').CommitPlan} CommitPlan
 * @typedef {import('./output.types.js').PlannedPrFinalizeOutput} PlannedPrFinalizeOutput
 * @typedef {import('./output.types.js').BlockedPrFinalizeOutput} BlockedPrFinalizeOutput
 * @typedef {import('./output.types.js').PrFinalizeOutput} PrFinalizeOutput
 * @typedef {import('./output.types.js').PrFinalizeOutputValidationResult} PrFinalizeOutputValidationResult
 */

/** @type {import('../../operation-output/types.js').OperationOutputContract} */
const PR_FINALIZE_OUTPUT_CONTRACT = {
  required: {
    status: ['planned', 'blocked'],
    summary: 'string',
  },
};

/**
 * @param {unknown} input
 * @returns {PrFinalizeOutputValidationResult}
 */
export function validatePrFinalizeOutput(input) {
  const result = validateOperationOutput(input, PR_FINALIZE_OUTPUT_CONTRACT);
  if (!result.valid) {
    return result;
  }

  const status = /** @type {'planned' | 'blocked'} */ (result.value.status);
  const summary = readNonEmptyString(result.value.summary, 'Operation Output.summary');
  if (!summary.valid) {
    return summary;
  }

  const supportedFields = findUnsupportedFields(result.value, {
    allowed:
      status === 'blocked'
        ? ['status', 'summary', 'failureReason']
        : ['status', 'summary', 'commitPlan', 'followUps'],
  });
  if (supportedFields.length > 0) {
    return invalid(
      `Operation Output contains unsupported PR Finalize planner fields: ${supportedFields.join(
        ', ',
      )}.`,
    );
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

  const commitPlan = readCommitPlan(result.value.commitPlan, 'Operation Output.commitPlan');
  if (!commitPlan.valid) {
    return commitPlan;
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
      commitPlan: commitPlan.value,
      followUps: Array.isArray(followUps) ? followUps : followUps.value,
    },
  };
}

/**
 * @param {Record<string, unknown>} value
 * @param {{ allowed: string[] }} options
 * @returns {string[]}
 */
function findUnsupportedFields(value, { allowed }) {
  return Object.keys(value).filter(field => !allowed.includes(field));
}

/**
 * @param {unknown} value
 * @param {string} path
 * @returns {{ valid: true, value: CommitPlan } | { valid: false, reason: string }}
 */
function readCommitPlan(value, path) {
  if (!isPlainObject(value)) {
    return invalid(`${path} must be an object.`);
  }

  const commits = readPlannedCommits(value.commits, `${path}.commits`);
  if (!commits.valid) {
    return commits;
  }

  const justification =
    value.justification === undefined
      ? undefined
      : readNonEmptyString(value.justification, `${path}.justification`);
  if (justification !== undefined && !justification.valid) {
    return justification;
  }

  return {
    valid: true,
    value: {
      ...(justification === undefined ? {} : { justification: justification.value }),
      commits: commits.value,
    },
  };
}

/**
 * @param {unknown} value
 * @param {string} path
 * @returns {{ valid: true, value: PlannedCommit[] } | { valid: false, reason: string }}
 */
function readPlannedCommits(value, path) {
  if (!Array.isArray(value)) {
    return invalid(`${path} must be an array.`);
  }

  if (value.length === 0) {
    return invalid(`${path} must include at least one commit.`);
  }

  /** @type {PlannedCommit[]} */
  const commits = [];
  for (const [index, item] of value.entries()) {
    if (!isPlainObject(item)) {
      return invalid(`${path}[${index}] must be an object.`);
    }

    const header = readNonEmptyString(item.header, `${path}[${index}].header`);
    if (!header.valid) {
      return header;
    }

    const body = readStringArray(item.body, `${path}[${index}].body`);
    if (!body.valid) {
      return body;
    }

    const footers = readNonEmptyStringArray(item.footers, `${path}[${index}].footers`);
    if (!footers.valid) {
      return footers;
    }

    const files = readNonEmptyStringArray(item.files, `${path}[${index}].files`);
    if (!files.valid) {
      return files;
    }

    commits.push({
      header: header.value,
      body: body.value,
      footers: footers.value,
      files: files.value,
    });
  }

  return { valid: true, value: commits };
}

/**
 * @param {unknown} value
 * @param {string} path
 * @returns {{ valid: true, value: string[] } | { valid: false, reason: string }}
 */
function readNonEmptyStringArray(value, path) {
  const result = readStringArray(value, path);
  if (!result.valid) {
    return result;
  }

  if (result.value.length === 0) {
    return invalid(`${path} must include at least one item.`);
  }

  return result;
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
