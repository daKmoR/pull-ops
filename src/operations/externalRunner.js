import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import { readLocalRunStateRecordFromDirectory } from '../local-run-state/localRunState.js';
import { readRunnerResult, RUNNER_RESULT_FILE } from '../runner/runnerResult.js';

export const EXTERNAL_RUNNER_PROMPT_FILE = 'runner_prompt.md';
export const EXTERNAL_RUNNER_OUTPUT_FILE = 'runner_output.json';
export const SUPPRESS_FOLLOW_UP_OPERATION_LABELS_ENV =
  'PULLOPS_SUPPRESS_FOLLOW_UP_OPERATION_LABELS';

/**
 * @typedef {import('../cli/types.js').OperationRunnerContext} OperationRunnerContext
 * @typedef {import('../runner/runnerResult.types.js').RunnerResultStatus} RunnerResultStatus
 * @typedef {import('../runner/types.js').ExternalRunnerCommand} ExternalRunnerCommand
 * @typedef {import('../runner/types.js').ExternalRunnerJob} ExternalRunnerJob
 */

/**
 * @param {OperationRunnerContext} context
 * @param {string} prompt
 * @param {{ branch?: string }} [options]
 * @returns {Promise<{
 *   promptFile: string,
 *   outputFile: string,
 *   resultFile: string,
 *   workerPrompt: string,
 *   heartbeatEnvironment?: Record<string, string>,
 * }>}
 */
export async function writeExternalRunnerPrompt(context, prompt, options = {}) {
  const outputDirectory = requireOutputDirectory(context);
  await mkdir(outputDirectory, { recursive: true });

  const files = getExternalRunnerFiles(context);
  const heartbeatEnvironment = await readWorkerHeartbeatEnvironment(outputDirectory);
  const workerPrompt = buildExternalRunnerWorkerPrompt({
    prompt,
    files,
    cwd: resolve(context.cwd),
    branch: options.branch,
    heartbeatEnvironment,
  });
  await writeFile(files.promptFile, workerPrompt);
  return {
    ...files,
    workerPrompt,
    ...(heartbeatEnvironment === undefined ? {} : { heartbeatEnvironment }),
  };
}

/**
 * @param {OperationRunnerContext} context
 * @param {{ rejectSkippedPreparedRunner?: boolean }} [options]
 * @returns {Promise<string>}
 */
export async function readExternalRunnerOutput(context, options = {}) {
  const result = await readRunnerResult({
    cwd: context.cwd,
    outputDirectory: context.outputDirectory,
  });

  if (result.result.status === 'skipped') {
    if (
      options.rejectSkippedPreparedRunner === true &&
      (await didExternalRunnerPrepareRunner(context))
    ) {
      throw new ExternalRunnerUnexpectedSkippedError();
    }

    throw new ExternalRunnerSkippedError();
  }

  if (result.result.status !== 'success') {
    throw new ExternalRunnerFailedError(result.result.status);
  }

  return await readFile(join(requireOutputDirectory(context), EXTERNAL_RUNNER_OUTPUT_FILE), 'utf8');
}

/**
 * @param {OperationRunnerContext} context
 * @returns {Record<string, unknown>}
 */
export function createSkippedExternalRunnerOutput(context) {
  return {
    status: 'accepted',
    summary: [
      `Skipped ${context.operation} for ${context.target.type} #${context.target.number}`,
      'because prepare did not request a runner step.',
    ].join(' '),
    runner: {
      adapter: 'external',
      status: 'skipped',
    },
  };
}

/**
 * @param {OperationRunnerContext} context
 * @returns {{ promptFile: string, outputFile: string, resultFile: string }}
 */
export function getExternalRunnerFiles(context) {
  const outputDirectory = requireOutputDirectory(context);
  return {
    promptFile: join(outputDirectory, EXTERNAL_RUNNER_PROMPT_FILE),
    outputFile: join(outputDirectory, EXTERNAL_RUNNER_OUTPUT_FILE),
    resultFile: join(outputDirectory, RUNNER_RESULT_FILE),
  };
}

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<boolean>}
 */
async function didExternalRunnerPrepareRunner(context) {
  try {
    await access(getExternalRunnerFiles(context).promptFile);
    return true;
  } catch (error) {
    if (isErrorWithCode(error, 'ENOENT')) {
      return false;
    }

    throw error;
  }
}

/**
 * @param {OperationRunnerContext} context
 * @param {{
 *   promptFile: string,
 *   outputFile: string,
 *   resultFile: string,
 *   workerPrompt: string,
 *   heartbeatEnvironment?: Record<string, string>,
 * }} files
 * @param {{ model: string, branch: string }} options
 * @returns {ExternalRunnerJob}
 */
export function createExternalRunnerJob(context, files, { model, branch }) {
  const outputDirectory = requireOutputDirectory(context);
  return {
    cwd: resolve(context.cwd),
    promptFile: files.promptFile,
    outputFile: files.outputFile,
    resultFile: files.resultFile,
    workerPrompt: files.workerPrompt,
    ...(files.heartbeatEnvironment === undefined
      ? {}
      : { heartbeatEnvironment: files.heartbeatEnvironment }),
    model,
    branch,
    completionCommands: /** @type {Record<RunnerResultStatus, ExternalRunnerCommand>} */ (
      Object.fromEntries(
        /** @type {RunnerResultStatus[]} */ (['success', 'failed', 'cancelled', 'skipped']).map(
          status => [
            status,
            {
              argv: [
                'npm',
                'exec',
                '--',
                'pullops',
                'runner-result',
                '--status',
                status,
                '--file',
                files.resultFile,
              ],
              env: createExternalRunnerCommandEnvironment(),
            },
          ],
        ),
      )
    ),
    completeCommand: createExternalRunnerCompleteCommand(context, outputDirectory),
  };
}

/**
 * @param {OperationRunnerContext} context
 * @param {string} outputDirectory
 * @returns {ExternalRunnerCommand}
 */
function createExternalRunnerCompleteCommand(context, outputDirectory) {
  return {
    argv: [
      'npm',
      'exec',
      '--',
      'pullops',
      'run',
      context.operation,
      '--runner',
      'external',
      '--phase',
      'complete',
      context.target.type === 'issue' ? '--issue' : '--pr',
      String(context.target.number),
    ],
    env: {
      ...createExternalRunnerCommandEnvironment(),
      OUTPUT_DIR: outputDirectory,
      ...(context.executionBackend === 'local' || context.suppressFollowUpOperationLabels === true
        ? { [SUPPRESS_FOLLOW_UP_OPERATION_LABELS_ENV]: '1' }
        : {}),
    },
  };
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
export function isSkippedExternalRunnerResult(error) {
  return error instanceof ExternalRunnerSkippedError;
}

/**
 * @param {object} options
 * @param {string} options.prompt
 * @param {{ outputFile: string, resultFile: string }} options.files
 * @param {string} options.cwd
 * @param {string} [options.branch]
 * @param {Record<string, string>} [options.heartbeatEnvironment]
 * @returns {string}
 */
function buildExternalRunnerWorkerPrompt({ prompt, files, cwd, branch, heartbeatEnvironment }) {
  return [
    'External runner artifact contract:',
    `- Write the final Operation Output JSON to ${files.outputFile}.`,
    `- Do not write ${files.resultFile}; the manager-owned completion command writes it.`,
    ...(branch === undefined
      ? []
      : [
          `- Before editing files, ensure the checkout in ${cwd} is on branch \`${branch}\`; if needed, run \`git checkout ${branch}\`.`,
        ]),
    ...(heartbeatEnvironment === undefined || Object.keys(heartbeatEnvironment).length === 0
      ? []
      : [
          '- Run every `pullops step` and `pullops heartbeat` command with this environment so heartbeats reach this run:',
          ...Object.entries(heartbeatEnvironment).map(([key, value]) => `  - ${key}=${value}`),
        ]),
    '',
    prompt,
  ].join('\n');
}

/**
 * The PullOps Heartbeat environment for the hidden worker, read from the run
 * record's Local Run State. Only the PULLOPS_-prefixed liveness entries are
 * shared; cache paths stay host-owned.
 *
 * @param {string} outputDirectory
 * @returns {Promise<Record<string, string> | undefined>}
 */
async function readWorkerHeartbeatEnvironment(outputDirectory) {
  let record;
  try {
    record = await readLocalRunStateRecordFromDirectory(outputDirectory);
  } catch (error) {
    if (isErrorWithCode(error, 'ENOENT')) {
      return undefined;
    }

    throw error;
  }

  return Object.fromEntries(
    Object.entries(record.heartbeatEnvironment).filter(
      /** @returns {entry is [string, string]} */
      entry => entry[0].startsWith('PULLOPS_') && typeof entry[1] === 'string',
    ),
  );
}

/**
 * @returns {Record<string, string>}
 */
function createExternalRunnerCommandEnvironment() {
  return {
    npm_config_cache: '/tmp/pullops-npm-cache',
  };
}

/**
 * @param {OperationRunnerContext} context
 * @returns {string}
 */
function requireOutputDirectory(context) {
  if (context.outputDirectory === undefined || context.outputDirectory.trim() === '') {
    throw new Error('External runner phases require OUTPUT_DIR.');
  }

  return isAbsolute(context.outputDirectory)
    ? context.outputDirectory
    : resolve(context.cwd, context.outputDirectory);
}

class ExternalRunnerSkippedError extends Error {
  constructor() {
    super('External runner result is skipped.');
    this.name = 'ExternalRunnerSkippedError';
  }
}

class ExternalRunnerFailedError extends Error {
  /**
   * @param {Exclude<RunnerResultStatus, 'success' | 'skipped'>} status
   */
  constructor(status) {
    super(`External runner completed with status "${status}".`);
    this.name = 'ExternalRunnerFailedError';
    this.status = status;
  }
}

class ExternalRunnerUnexpectedSkippedError extends Error {
  constructor() {
    super('External runner result is skipped even though prepare requested a runner step.');
    this.name = 'ExternalRunnerUnexpectedSkippedError';
  }
}

/**
 * @param {unknown} error
 * @param {string} code
 * @returns {boolean}
 */
function isErrorWithCode(error, code) {
  return error instanceof Error && /** @type {NodeJS.ErrnoException} */ (error).code === code;
}
