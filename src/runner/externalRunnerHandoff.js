import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

import { isRunnerResultStatus } from './runnerResult.js';

/**
 * @typedef {import('./runnerResult.types.js').RunnerResultStatus} RunnerResultStatus
 * @typedef {import('./types.js').ExternalRunnerCommand} ExternalRunnerCommand
 * @typedef {import('./types.js').ExternalRunnerCommandRunner} ExternalRunnerCommandRunner
 * @typedef {import('./types.js').ExternalRunnerJob} ExternalRunnerJob
 * @typedef {import('./types.js').ExternalRunnerJobRunner} ExternalRunnerJobRunner
 */

const execFileAsync = promisify(execFile);
const MAX_EXTERNAL_RUNNER_HANDOFFS = 8;

/**
 * @param {object} options
 * @param {ExternalRunnerJob} options.runnerJob
 * @param {ExternalRunnerJobRunner} options.runWorker
 * @param {ExternalRunnerCommandRunner} [options.runCommand]
 * @param {string} [options.cwd]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function executeExternalRunnerHandoff({ runnerJob, runWorker, runCommand, cwd }) {
  let currentRunnerJob = runnerJob;

  for (let pass = 0; pass < MAX_EXTERNAL_RUNNER_HANDOFFS; pass += 1) {
    const status = await runExternalRunnerWorker(currentRunnerJob, runWorker);
    const completionCommand = currentRunnerJob.completionCommands[status];
    if (completionCommand === undefined) {
      throw new Error(`External runner job is missing a completion command for "${status}".`);
    }

    const commandCwd = cwd ?? currentRunnerJob.cwd;
    await runCommandWithCwd(completionCommand, runCommand, commandCwd);
    const completeOutput = await runCommandWithCwd(
      currentRunnerJob.completeCommand,
      runCommand,
      commandCwd,
    );

    if (!isExternalRunnerWaitingOutput(completeOutput)) {
      return completeOutput;
    }

    currentRunnerJob = completeOutput.runnerJob;
  }

  throw new Error(
    `External runner handoff limit exceeded after ${MAX_EXTERNAL_RUNNER_HANDOFFS} pass(es).`,
  );
}

/**
 * @param {ExternalRunnerCommand} command
 * @param {{ cwd: string }} options
 * @returns {Promise<Record<string, unknown>>}
 */
export async function runExternalRunnerCommand(command, { cwd }) {
  const [file, ...args] = command.argv;
  if (file === undefined || file.trim() === '') {
    throw new Error('External runner command is missing argv[0].');
  }

  const result = await execFileAsync(file, args, {
    cwd,
    env: {
      ...process.env,
      ...command.env,
    },
    maxBuffer: 10 * 1024 * 1024,
  });
  return parseCommandOutput(result.stdout);
}

/**
 * @param {Record<string, unknown>} output
 * @returns {output is Record<string, unknown> & { status: 'waiting', runnerJob: ExternalRunnerJob }}
 */
export function isExternalRunnerWaitingOutput(output) {
  return output.status === 'waiting' && isRecord(output.runnerJob);
}

/**
 * @param {ExternalRunnerJob} runnerJob
 * @param {ExternalRunnerJobRunner} runWorker
 * @returns {Promise<RunnerResultStatus>}
 */
async function runExternalRunnerWorker(runnerJob, runWorker) {
  /** @type {RunnerResultStatus} */
  let status;
  try {
    status = normalizeWorkerStatus(await runWorker(runnerJob));
  } catch {
    status = 'failed';
  }

  if (status === 'success' && !(await hasNonEmptyRunnerOutput(runnerJob.outputFile))) {
    return 'failed';
  }

  return status;
}

/**
 * @param {unknown} result
 * @returns {RunnerResultStatus}
 */
function normalizeWorkerStatus(result) {
  if (result === undefined) {
    return 'success';
  }

  if (isRunnerResultStatus(result)) {
    return result;
  }

  if (isRecord(result) && isRunnerResultStatus(result.status)) {
    return result.status;
  }

  throw new Error(`External runner worker returned unsupported status "${String(result)}".`);
}

/**
 * @param {string} outputFile
 * @returns {Promise<boolean>}
 */
async function hasNonEmptyRunnerOutput(outputFile) {
  try {
    return (await readFile(outputFile)).length > 0;
  } catch {
    return false;
  }
}

/**
 * @param {ExternalRunnerCommand} command
 * @param {ExternalRunnerCommandRunner | undefined} runCommand
 * @param {string} cwd
 * @returns {Promise<Record<string, unknown>>}
 */
async function runCommandWithCwd(command, runCommand, cwd) {
  if (runCommand === undefined) {
    return await runExternalRunnerCommand(command, { cwd });
  }

  return await runCommand(command);
}

/**
 * @param {string | Buffer} stdout
 * @returns {Record<string, unknown>}
 */
function parseCommandOutput(stdout) {
  const text = Buffer.isBuffer(stdout) ? stdout.toString('utf8') : stdout;
  const trimmed = text.trim();
  if (trimmed === '') {
    return {};
  }

  const output = JSON.parse(trimmed);
  if (!isRecord(output)) {
    throw new Error('External runner command output must be a JSON object.');
  }

  return output;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
