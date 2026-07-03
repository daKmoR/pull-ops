import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { validateOperationOutput } from '../operation-output/OperationOutput.js';

/**
 * @typedef {import('./runnerResult.types.js').RunnerResult} RunnerResult
 * @typedef {import('./runnerResult.types.js').RunnerResultStatus} RunnerResultStatus
 */

export const RUNNER_RESULT_FILE = 'runner_result.json';

/** @type {readonly RunnerResultStatus[]} */
export const RUNNER_RESULT_STATUSES = Object.freeze(['success', 'failed', 'cancelled', 'skipped']);

/** @type {import('../operation-output/types.js').OperationOutputContract} */
const RUNNER_RESULT_CONTRACT = {
  required: {
    schemaVersion: 'number',
    status: RUNNER_RESULT_STATUSES,
  },
};

/**
 * @param {object} options
 * @param {string} options.cwd
 * @param {RunnerResultStatus} options.status
 * @param {string} [options.outputDirectory]
 * @param {string} [options.resultFile]
 * @returns {Promise<{ resultFile: string, result: RunnerResult }>}
 */
export async function writeRunnerResult({ cwd, status, outputDirectory, resultFile }) {
  const resolvedResultFile = resolveRunnerResultFile({ cwd, outputDirectory, resultFile });
  /** @type {RunnerResult} */
  const result = {
    schemaVersion: 1,
    status,
  };
  const validated = validateRunnerResult(result);
  if (!validated.valid) {
    throw new Error(`Invalid external runner result: ${validated.reason}`);
  }

  await mkdir(dirname(resolvedResultFile), { recursive: true });
  await writeFile(resolvedResultFile, `${JSON.stringify(validated.value, null, 2)}\n`);

  return {
    resultFile: resolvedResultFile,
    result: validated.value,
  };
}

/**
 * @param {object} options
 * @param {string} options.cwd
 * @param {string} [options.outputDirectory]
 * @param {string} [options.resultFile]
 * @returns {Promise<{ resultFile: string, result: RunnerResult }>}
 */
export async function readRunnerResult({ cwd, outputDirectory, resultFile }) {
  const resolvedResultFile = resolveRunnerResultFile({ cwd, outputDirectory, resultFile });
  let rawResult;
  try {
    rawResult = await readFile(resolvedResultFile, 'utf8');
  } catch (error) {
    throw new Error(
      `External runner contract error: missing ${RUNNER_RESULT_FILE} at ${resolvedResultFile}.`,
      { cause: error },
    );
  }

  const validated = validateRunnerResult(rawResult);
  if (!validated.valid) {
    throw new Error(
      `External runner contract error: invalid ${RUNNER_RESULT_FILE}: ${validated.reason}`,
    );
  }

  return {
    resultFile: resolvedResultFile,
    result: validated.value,
  };
}

/**
 * @param {unknown} input
 * @returns {{ valid: true, value: RunnerResult } | { valid: false, reason: string }}
 */
export function validateRunnerResult(input) {
  const result = validateOperationOutput(input, RUNNER_RESULT_CONTRACT);
  if (!result.valid) {
    return result;
  }

  if (result.value.schemaVersion !== 1) {
    return invalid('Operation Output.schemaVersion must be 1.');
  }

  return {
    valid: true,
    value: {
      schemaVersion: 1,
      status: /** @type {RunnerResultStatus} */ (result.value.status),
    },
  };
}

/**
 * @param {object} options
 * @param {string} options.cwd
 * @param {string} [options.outputDirectory]
 * @param {string} [options.resultFile]
 * @returns {string}
 */
export function resolveRunnerResultFile({ cwd, outputDirectory, resultFile }) {
  if (resultFile !== undefined && resultFile.trim() !== '') {
    return isAbsolute(resultFile) ? resultFile : resolve(cwd, resultFile);
  }

  if (outputDirectory === undefined || outputDirectory.trim() === '') {
    throw new Error(`Missing external runner result path. Pass "--file <path>" or set OUTPUT_DIR.`);
  }

  const resolvedOutputDirectory = isAbsolute(outputDirectory)
    ? outputDirectory
    : resolve(cwd, outputDirectory);
  return join(resolvedOutputDirectory, RUNNER_RESULT_FILE);
}

/**
 * @param {unknown} value
 * @returns {value is RunnerResultStatus}
 */
export function isRunnerResultStatus(value) {
  return (
    typeof value === 'string' &&
    RUNNER_RESULT_STATUSES.includes(/** @type {RunnerResultStatus} */ (value))
  );
}

/**
 * @param {string} reason
 * @returns {{ valid: false, reason: string }}
 */
function invalid(reason) {
  return { valid: false, reason };
}
