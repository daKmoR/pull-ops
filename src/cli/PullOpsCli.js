import { loadPullOpsConfig } from '../config/PullOpsConfig.js';
import { createGitClient } from '../git/GitClient.js';
import { createGitHubClient, PULL_OPS_LABELS } from '../github/GitHubClient.js';
import { validateOperationOutput } from '../operation-output/OperationOutput.js';
import {
  getWorkflowOperation,
  runWorkflowOperation,
  WORKFLOW_OPERATION_NAMES,
} from '../operations/operations.js';
import { createCodexRunner } from '../runner/CodexRunner.js';
import { isRunnerAdapter, RUNNER_ADAPTERS } from '../runner/runnerAdapters.js';

/**
 * @typedef {import('./types.js').WritableLike} WritableLike
 * @typedef {import('./types.js').OperationRunnerContext} OperationRunnerContext
 * @typedef {import('./types.js').OperationPhase} OperationPhase
 * @typedef {import('./types.js').OperationRunner} OperationRunner
 * @typedef {import('../runner/types.js').RunnerAdapter} RunnerAdapter
 * @typedef {import('../github/types.js').GitHubClient} GitHubClient
 * @typedef {import('../git/types.js').GitClient} GitClient
 * @typedef {import('../runner/types.js').CodexRunner} CodexRunner
 * @typedef {import('../github/types.js').EnsureLabelsResult} EnsureLabelsResult
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
   * @param {GitClient} [options.gitClient]
   * @param {CodexRunner} [options.codexRunner]
   * @param {OperationRunner} [options.operationRunner]
   * @param {NodeJS.ProcessEnv} [options.env]
   */
  constructor({
    cwd = process.cwd(),
    stdout = process.stdout,
    stderr = process.stderr,
    githubClient = createGitHubClient(),
    gitClient,
    codexRunner = createCodexRunner(),
    operationRunner = runWorkflowOperation,
    env = process.env,
  } = {}) {
    this.cwd = cwd;
    this.stdout = stdout;
    this.stderr = stderr;
    this.githubClient = githubClient;
    this.gitClient = gitClient ?? createGitClient({ env });
    this.codexRunner = codexRunner;
    this.operationRunner = operationRunner;
    this.env = env;
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

    const config = await loadPullOpsConfig({ cwd: this.cwd });
    const parsedArgs = parseRunOperationArgs(operationArgs, operation, config.runner.adapter);
    const operationConfig = config.operations[operation.configKey];
    const model = config.runner.models[operationConfig.modelTier];

    const output = await this.operationRunner({
      operation: operation.name,
      phase: parsedArgs.phase,
      runnerAdapter: parsedArgs.runnerAdapter,
      target: {
        type: operation.target,
        number: parsedArgs.targetNumber,
      },
      cwd: this.cwd,
      config,
      modelTier: operationConfig.modelTier,
      model,
      githubClient: this.githubClient,
      gitClient: this.gitClient,
      codexRunner: this.codexRunner,
      triggerActor: this.env.GITHUB_ACTOR,
      outputDirectory: this.env.OUTPUT_DIR,
      codexActionOutcome: this.env.PULLOPS_CODEX_ACTION_OUTCOME,
      runnerRan: parsedArgs.runnerRan,
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

    const result = await this.githubClient.ensureLabels(PULL_OPS_LABELS);

    this.writeValidatedJson({
      status: 'accepted',
      summary: summarizeEnsureLabelsResult(PULL_OPS_LABELS.length, result),
      labels: result,
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
 * @param {string[]} args
 * @param {import('../operations/types.js').WorkflowOperation} operation
 * @param {RunnerAdapter} defaultRunnerAdapter
 * @returns {{ targetNumber: number, phase: OperationPhase, runnerAdapter: RunnerAdapter, runnerRan?: boolean }}
 */
function parseRunOperationArgs(args, operation, defaultRunnerAdapter) {
  const consumed = new Set();
  const targetNumber = parseRequiredNumberOption(args, operation.option, operation.name, consumed);
  const phase = parseOperationPhase(args, consumed);
  const runnerAdapter = parseRunnerAdapter(args, defaultRunnerAdapter, consumed);
  const runnerRan = parseRunnerRan(args, consumed);

  validateRunnerLifecycle({ operationName: operation.name, phase, runnerAdapter, runnerRan });

  const unknown = args.filter((unused, argIndex) => {
    void unused;
    return !consumed.has(argIndex);
  });
  if (unknown.length > 0) {
    throw new CliUsageError(`Unknown arguments for ${operation.name}: ${unknown.join(' ')}.`);
  }

  return {
    targetNumber,
    phase,
    runnerAdapter,
    ...(runnerRan === undefined ? {} : { runnerRan }),
  };
}

/**
 * @param {string[]} args
 * @param {string} option
 * @param {string} operationName
 * @param {Set<number>} consumed
 * @returns {number}
 */
function parseRequiredNumberOption(args, option, operationName, consumed) {
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

  consumed.add(index);
  consumed.add(index + 1);

  const number = Number(rawValue);
  if (!Number.isInteger(number) || number <= 0) {
    throw new CliUsageError(`"${optionName}" must be a positive integer.`);
  }

  return number;
}

/**
 * @param {string[]} args
 * @param {Set<number>} consumed
 * @returns {OperationPhase}
 */
function parseOperationPhase(args, consumed) {
  const rawPhase = parseOptionalStringOption(args, '--phase', consumed);
  if (rawPhase === undefined) {
    return 'run';
  }

  if (rawPhase === 'run' || rawPhase === 'prepare' || rawPhase === 'finalize') {
    return rawPhase;
  }

  throw new CliUsageError(`Unknown phase "${rawPhase}". Expected one of: run, prepare, finalize.`);
}

/**
 * @param {string[]} args
 * @param {RunnerAdapter} defaultRunnerAdapter
 * @param {Set<number>} consumed
 * @returns {RunnerAdapter}
 */
function parseRunnerAdapter(args, defaultRunnerAdapter, consumed) {
  const rawRunner = parseOptionalStringOption(args, '--runner', consumed);
  if (rawRunner === undefined) {
    return defaultRunnerAdapter;
  }

  if (!isRunnerAdapter(rawRunner)) {
    throw new CliUsageError(
      `Unknown runner "${rawRunner}". Expected one of: ${RUNNER_ADAPTERS.join(', ')}.`,
    );
  }

  return rawRunner;
}

/**
 * @param {string[]} args
 * @param {Set<number>} consumed
 * @returns {boolean | undefined}
 */
function parseRunnerRan(args, consumed) {
  const rawRunnerRan = parseOptionalStringOption(args, '--runner-ran', consumed);
  if (rawRunnerRan === undefined) {
    return undefined;
  }

  if (rawRunnerRan === 'true') {
    return true;
  }

  if (rawRunnerRan === 'false') {
    return false;
  }

  throw new CliUsageError('"--runner-ran" must be either "true" or "false".');
}

/**
 * @param {string[]} args
 * @param {string} optionName
 * @param {Set<number>} consumed
 * @returns {string | undefined}
 */
function parseOptionalStringOption(args, optionName, consumed) {
  const index = args.indexOf(optionName);
  if (index === -1) {
    return undefined;
  }

  const rawValue = args[index + 1];
  if (rawValue === undefined || rawValue.startsWith('--')) {
    throw new CliUsageError(`Missing value for "${optionName}".`);
  }

  consumed.add(index);
  consumed.add(index + 1);
  return rawValue;
}

/**
 * @param {object} options
 * @param {string} options.operationName
 * @param {OperationPhase} options.phase
 * @param {RunnerAdapter} options.runnerAdapter
 * @param {boolean | undefined} options.runnerRan
 */
function validateRunnerLifecycle({ operationName, phase, runnerAdapter, runnerRan }) {
  if (runnerAdapter === 'codex-action') {
    if (phase === 'run') {
      throw new CliUsageError(
        `${operationName} with --runner codex-action requires "--phase prepare" or "--phase finalize".`,
      );
    }

    if (phase === 'prepare' && runnerRan !== undefined) {
      throw new CliUsageError('"--runner-ran" can only be used with "--phase finalize".');
    }

    if (phase === 'finalize' && runnerRan === undefined) {
      throw new CliUsageError(
        `${operationName} with --runner codex-action --phase finalize requires "--runner-ran <true|false>".`,
      );
    }

    return;
  }

  if (phase !== 'run') {
    throw new CliUsageError(
      `${operationName} with --runner ${runnerAdapter} only supports the default run phase.`,
    );
  }

  if (runnerRan !== undefined) {
    throw new CliUsageError('"--runner-ran" can only be used with "--runner codex-action".');
  }
}

/**
 * @returns {string}
 */
function usage() {
  return [
    'Usage:',
    '  pullops run <operation> [--runner codex-cli] --issue <number>',
    '  pullops run <operation> [--runner codex-cli] --pr <number>',
    '  pullops run <operation> --runner codex-action --phase prepare --issue <number>',
    '  pullops run <operation> --runner codex-action --phase finalize --runner-ran <true|false> --issue <number>',
    '  pullops run <operation> --runner codex-action --phase prepare --pr <number>',
    '  pullops run <operation> --runner codex-action --phase finalize --runner-ran <true|false> --pr <number>',
    '  pullops labels ensure',
  ].join('\n');
}

/**
 * @param {number} total
 * @param {EnsureLabelsResult} result
 * @returns {string}
 */
function summarizeEnsureLabelsResult(total, result) {
  return [
    `Ensured ${total} PullOps labels:`,
    `${result.created.length} created,`,
    `${result.updated.length} updated,`,
    `${result.alreadyCorrect.length} already correct.`,
  ].join(' ');
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

class CliUsageError extends Error {}
