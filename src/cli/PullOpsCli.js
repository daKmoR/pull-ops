import { loadPullOpsConfig } from '../config/PullOpsConfig.js';
import { createGitHubClient, PULL_OPS_LABELS } from '../github/GitHubClient.js';
import { validateOperationOutput } from '../operation-output/OperationOutput.js';
import { getWorkflowOperation, WORKFLOW_OPERATION_NAMES } from '../operations/operations.js';

/**
 * @typedef {import('./types.js').WritableLike} WritableLike
 * @typedef {import('./types.js').OperationRunnerContext} OperationRunnerContext
 * @typedef {import('./types.js').OperationRunner} OperationRunner
 * @typedef {import('../github/types.js').GitHubClient} GitHubClient
 */

/** @type {import('../operation-output/types.js').OperationOutputContract} */
const COMMAND_OUTPUT_CONTRACT = {
  required: {
    status: 'string',
    summary: 'string',
  },
};

export class PullOpsCli {
  /**
   * @param {object} [options]
   * @param {string} [options.cwd]
   * @param {WritableLike} [options.stdout]
   * @param {WritableLike} [options.stderr]
   * @param {GitHubClient} [options.githubClient]
   * @param {OperationRunner} [options.operationRunner]
   */
  constructor({
    cwd = process.cwd(),
    stdout = process.stdout,
    stderr = process.stderr,
    githubClient = createGitHubClient(),
    operationRunner = runPlaceholderOperation,
  } = {}) {
    this.cwd = cwd;
    this.stdout = stdout;
    this.stderr = stderr;
    this.githubClient = githubClient;
    this.operationRunner = operationRunner;
  }

  /**
   * @param {string[]} [argv]
   * @returns {Promise<number>}
   */
  async start(argv = process.argv.slice(2)) {
    process.exitCode = await this.run(argv);
    return process.exitCode;
  }

  /**
   * @param {string[]} [argv]
   * @returns {Promise<number>}
   */
  async run(argv = []) {
    try {
      return await this.runCommand(argv);
    } catch (error) {
      this.writeError(getErrorMessage(error));
      return 1;
    }
  }

  /**
   * @param {string[]} argv
   * @returns {Promise<number>}
   */
  async runCommand(argv) {
    const [command, ...args] = argv;

    if (command === undefined) {
      throw new CliUsageError(`Missing command.\n\n${usage()}`);
    }

    if (command === '--help' || command === '-h') {
      this.stdout.write(`${usage()}\n`);
      return 0;
    }

    if (command === 'run') {
      return await this.runOperation(args);
    }

    if (command === 'labels') {
      return await this.runLabels(args);
    }

    throw new CliUsageError(`Unknown command "${command}".\n\n${usage()}`);
  }

  /**
   * @param {string[]} args
   * @returns {Promise<number>}
   */
  async runOperation(args) {
    const [operationName, ...operationArgs] = args;

    if (operationName === undefined) {
      throw new CliUsageError(
        `Missing operation. Expected one of: ${WORKFLOW_OPERATION_NAMES.join(', ')}.`,
      );
    }

    const operation = getWorkflowOperation(operationName);
    if (operation === undefined) {
      throw new CliUsageError(
        `Unknown operation "${operationName}". Expected one of: ${WORKFLOW_OPERATION_NAMES.join(
          ', ',
        )}.`,
      );
    }

    const targetNumber = parseRequiredNumberOption(operationArgs, operation.option, operation.name);
    const config = await loadPullOpsConfig({ cwd: this.cwd });
    const operationConfig = config.operations[operation.configKey];
    const model = config.runner.models[operationConfig.modelTier];

    const output = await this.operationRunner({
      operation: operation.name,
      target: {
        type: operation.target,
        number: targetNumber,
      },
      config,
      modelTier: operationConfig.modelTier,
      model,
      githubClient: this.githubClient,
    });

    this.writeValidatedJson(output);
    return 0;
  }

  /**
   * @param {string[]} args
   * @returns {Promise<number>}
   */
  async runLabels(args) {
    const [subcommand, ...rest] = args;

    if (subcommand !== 'ensure') {
      throw new CliUsageError('Expected "pullops labels ensure".');
    }

    if (rest.length > 0) {
      throw new CliUsageError(`Unknown labels ensure arguments: ${rest.join(' ')}.`);
    }

    await this.githubClient.ensureLabels(PULL_OPS_LABELS);

    this.writeValidatedJson({
      status: 'accepted',
      summary: `Ensured ${PULL_OPS_LABELS.length} PullOps labels.`,
      labels: PULL_OPS_LABELS.map(label => label.name),
    });
    return 0;
  }

  /**
   * @param {unknown} output
   */
  writeValidatedJson(output) {
    const result = validateOperationOutput(output, COMMAND_OUTPUT_CONTRACT);
    if (!result.valid) {
      throw new Error(`Invalid Operation Output: ${result.reason}`);
    }

    this.stdout.write(`${JSON.stringify(result.value, null, 2)}\n`);
  }

  /**
   * @param {string} message
   */
  writeError(message) {
    this.stderr.write(`${message}\n`);
  }
}

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
async function runPlaceholderOperation({ operation, target, modelTier, model }) {
  return {
    status: 'accepted',
    operation,
    summary: `Accepted ${operation} for ${target.type} #${target.number}; runner implementation is not wired yet.`,
    target,
    modelTier,
    model,
  };
}

/**
 * @param {string[]} args
 * @param {string} option
 * @param {string} operationName
 * @returns {number}
 */
function parseRequiredNumberOption(args, option, operationName) {
  const optionName = `--${option}`;
  const index = args.indexOf(optionName);

  if (index === -1) {
    throw new CliUsageError(
      `Missing required argument "${optionName} <number>" for ${operationName}.`,
    );
  }

  const rawValue = args[index + 1];
  if (rawValue === undefined || rawValue.startsWith('--')) {
    throw new CliUsageError(`Missing value for "${optionName}" in ${operationName}.`);
  }

  const consumed = new Set([index, index + 1]);
  const unknown = args.filter((unused, argIndex) => {
    void unused;
    return !consumed.has(argIndex);
  });
  if (unknown.length > 0) {
    throw new CliUsageError(`Unknown arguments for ${operationName}: ${unknown.join(' ')}.`);
  }

  const number = Number(rawValue);
  if (!Number.isInteger(number) || number <= 0) {
    throw new CliUsageError(`"${optionName}" must be a positive integer.`);
  }

  return number;
}

/**
 * @returns {string}
 */
function usage() {
  return [
    'Usage:',
    '  pullops run <operation> --issue <number>',
    '  pullops run <operation> --pr <number>',
    '  pullops labels ensure',
  ].join('\n');
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

class CliUsageError extends Error {}
