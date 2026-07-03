import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import { readRunnerResult, RUNNER_RESULT_FILE } from '../runner/runnerResult.js';

export const CODEX_ACTION_PROMPT_FILE = 'runner_prompt.md';
export const CODEX_ACTION_OUTPUT_FILE = 'runner_output.json';
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
 * @returns {Promise<{ promptFile: string, outputFile: string, resultFile: string, workerPrompt: string }>}
 */
export async function writeCodexActionPrompt(context, prompt, options = {}) {
  const outputDirectory = requireOutputDirectory(context);
  await mkdir(outputDirectory, { recursive: true });

  const files = getCodexActionFiles(context);
  const workerPrompt = buildExternalRunnerWorkerPrompt({
    prompt,
    files,
    cwd: resolve(context.cwd),
    branch: options.branch,
  });
  await writeFile(files.promptFile, workerPrompt);
  return {
    ...files,
    workerPrompt,
  };
}

/**
 * @param {OperationRunnerContext} context
 * @param {{ rejectSkippedPreparedRunner?: boolean }} [options]
 * @returns {Promise<string>}
 */
export async function readCodexActionOutput(context, options = {}) {
  const result = await readRunnerResult({
    cwd: context.cwd,
    outputDirectory: context.outputDirectory,
  });

  if (result.result.status === 'skipped') {
    if (
      options.rejectSkippedPreparedRunner === true &&
      (await didCodexActionPrepareRunner(context))
    ) {
      throw new ExternalRunnerUnexpectedSkippedError();
    }

    throw new ExternalRunnerSkippedError();
  }

  if (result.result.status !== 'success') {
    throw new ExternalRunnerFailedError(result.result.status);
  }

  return await readFile(join(requireOutputDirectory(context), CODEX_ACTION_OUTPUT_FILE), 'utf8');
}

/**
 * @param {OperationRunnerContext} context
 * @returns {Record<string, unknown>}
 */
export function createSkippedCodexActionOutput(context) {
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
export function getCodexActionFiles(context) {
  const outputDirectory = requireOutputDirectory(context);
  return {
    promptFile: join(outputDirectory, CODEX_ACTION_PROMPT_FILE),
    outputFile: join(outputDirectory, CODEX_ACTION_OUTPUT_FILE),
    resultFile: join(outputDirectory, RUNNER_RESULT_FILE),
  };
}

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<boolean>}
 */
async function didCodexActionPrepareRunner(context) {
  try {
    await access(getCodexActionFiles(context).promptFile);
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
 * @returns {string}
 */
function buildExternalRunnerWorkerPrompt({ prompt, files, cwd, branch }) {
  return [
    'External runner artifact contract:',
    `- Write the final Operation Output JSON to ${files.outputFile}.`,
    `- Do not write ${files.resultFile}; the manager-owned completion command writes it.`,
    ...(branch === undefined
      ? []
      : [
          `- Before editing files, ensure the checkout in ${cwd} is on branch \`${branch}\`; if needed, run \`git checkout ${branch}\`.`,
        ]),
    '',
    prompt,
  ].join('\n');
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
