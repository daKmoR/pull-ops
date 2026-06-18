import { loadPullOpsConfig } from '../config/PullOpsConfig.js';
import { createGitClient } from '../git/GitClient.js';
import { createGitHubClient, PULL_OPS_LABELS } from '../github/GitHubClient.js';
import { validateOperationOutput } from '../operation-output/OperationOutput.js';
import {
  getOperationLabelReference,
  getWorkflowOperation,
  LOCAL_OPERATION_LABEL_REFERENCE_NAMES,
  OPERATION_LABEL_REFERENCE_NAMES,
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

    if (isOperationLabelReferenceInput(operationName)) {
      return await this.runOperationLabelReference(operationName, operationArgs);
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
      reasoningEffort: readOptionalEnv(this.env.PULLOPS_REASONING_EFFORT),
      contextUsage: readContextUsage(this.env),
    });

    this.writeValidatedJson(output);
    return 0;
  }

  /**
   * @param {string} reference
   * @param {string[]} args
   * @returns {Promise<number>}
   */
  async runOperationLabelReference(reference, args) {
    if (reference.startsWith('pullops:')) {
      throw new CliUsageError(
        `Full PullOps labels are not accepted as operation references. Expected one of: ${OPERATION_LABEL_REFERENCE_NAMES.join(
          ', ',
        )}.`,
      );
    }

    const operation = getOperationLabelReference(reference);
    if (operation === undefined) {
      throw new CliUsageError(
        `Unknown operation label reference "${reference}". Expected one of: ${OPERATION_LABEL_REFERENCE_NAMES.join(
          ', ',
        )}.`,
      );
    }

    const backend = readOperationLabelBackend(args);
    if (backend === 'github-actions') {
      return await this.dispatchOperationLabelThroughGitHubActions(operation, reference, args);
    }

    if (backend !== undefined && backend !== 'local') {
      throw new CliUsageError(
        `Unknown backend "${backend}" for ${reference}. Expected one of: local, github-actions.`,
      );
    }

    if (reference === 'issue:implement') {
      return await this.runLocalIssueImplementReference(args);
    }

    if (reference === 'prd:auto-advance') {
      return await this.runLocalPrdAutoAdvanceReference(args);
    }

    if (reference === 'prd:auto-complete') {
      return await this.runLocalPrdAutoCompleteReference(args);
    }

    if (operation.target === 'pr') {
      return await this.runLocalPullRequestOperationReference(operation, reference, args);
    }

    throw new CliUsageError(localOperationLabelReferenceUnsupportedMessage(reference));
  }

  /**
   * @param {import('../operations/types.js').OperationLabelReference} operation
   * @param {string} reference
   * @param {string[]} args
   * @returns {Promise<number>}
   */
  async dispatchOperationLabelThroughGitHubActions(operation, reference, args) {
    const parsedArgs = parseGitHubActionsOperationLabelArgs(args, reference);

    if (operation.target === 'issue') {
      const issue = await this.githubClient.getIssue(parsedArgs.targetNumber);
      if (issue.labels.includes(operation.label)) {
        await this.githubClient.removeLabelsFromIssue({
          number: parsedArgs.targetNumber,
          labels: [operation.label],
        });
      }

      await this.githubClient.addLabelsToIssue({
        number: parsedArgs.targetNumber,
        labels: [operation.label],
      });
    } else {
      const pullRequest = await this.githubClient.getPullRequest(parsedArgs.targetNumber);
      if (pullRequest.labels?.includes(operation.label) === true) {
        await this.githubClient.removeLabelsFromPullRequest({
          number: parsedArgs.targetNumber,
          labels: [operation.label],
        });
      }

      await this.githubClient.addLabelsToPullRequest({
        number: parsedArgs.targetNumber,
        labels: [operation.label],
      });
    }

    this.writeValidatedJson({
      status: 'accepted',
      summary: `Applied ${operation.label} to ${formatTargetKind(operation.target)} #${parsedArgs.targetNumber}.`,
      operation: operation.label,
      target: {
        type: operation.target,
        number: parsedArgs.targetNumber,
      },
      backend: parsedArgs.backend,
    });
    return 0;
  }

  /**
   * @param {import('../operations/types.js').OperationLabelReference} operation
   * @param {string} reference
   * @param {string[]} args
   * @returns {Promise<number>}
   */
  async runLocalPullRequestOperationReference(operation, reference, args) {
    const parsedArgs = parseLocalPullRequestOperationReferenceArgs(args, reference);
    const workflowOperation = getWorkflowOperation(operation.workflowOperationName);
    if (workflowOperation === undefined) {
      throw new Error(`${operation.workflowOperationName} operation is not registered.`);
    }

    const config = await loadPullOpsConfig({ cwd: this.cwd });
    const operationConfig = config.operations[workflowOperation.configKey];
    const model = config.runner.models[operationConfig.modelTier];
    const runnerAdapter = config.runner.adapter;
    validateRunnerLifecycle({
      operationName: workflowOperation.name,
      phase: 'run',
      runnerAdapter,
      runnerRan: undefined,
    });
    const output = await this.operationRunner({
      operation: workflowOperation.name,
      phase: 'run',
      runnerAdapter,
      executionBackend: 'local',
      target: {
        type: 'pr',
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
      reasoningEffort: readOptionalEnv(this.env.PULLOPS_REASONING_EFFORT),
      contextUsage: readContextUsage(this.env),
    });

    this.writeValidatedJson(output);
    return 0;
  }

  /**
   * @param {string[]} args
   * @returns {Promise<number>}
   */
  async runLocalIssueImplementReference(args) {
    const parsedArgs = parseLocalIssueImplementReferenceArgs(args);
    const operation = getWorkflowOperation('issue-implement');
    if (operation === undefined) {
      throw new Error('issue-implement operation is not registered.');
    }

    const config = await loadPullOpsConfig({ cwd: this.cwd });
    const operationConfig = config.operations[operation.configKey];
    const model = config.runner.models[operationConfig.modelTier];
    const runnerAdapter = config.runner.adapter;
    validateRunnerLifecycle({
      operationName: operation.name,
      phase: 'run',
      runnerAdapter,
      runnerRan: undefined,
    });
    const output = await this.operationRunner({
      operation: operation.name,
      phase: 'run',
      runnerAdapter,
      executionBackend: 'local',
      publicationMode: parsedArgs.publicationMode,
      runGoal: parsedArgs.runGoal,
      target: {
        type: 'issue',
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
      reasoningEffort: readOptionalEnv(this.env.PULLOPS_REASONING_EFFORT),
      contextUsage: readContextUsage(this.env),
    });

    this.writeValidatedJson(output);
    return 0;
  }

  /**
   * @param {string[]} args
   * @returns {Promise<number>}
   */
  async runLocalPrdAutoAdvanceReference(args) {
    const parsedArgs = parseLocalPrdAutomationReferenceArgs(args, 'prd:auto-advance');
    const operation = getWorkflowOperation('prd-auto-advance');
    if (operation === undefined) {
      throw new Error('prd-auto-advance operation is not registered.');
    }

    const config = await loadPullOpsConfig({ cwd: this.cwd });
    const operationConfig = config.operations[operation.configKey];
    const model = config.runner.models[operationConfig.modelTier];
    const runnerAdapter = config.runner.adapter;
    validateRunnerLifecycle({
      operationName: operation.name,
      phase: 'run',
      runnerAdapter,
      runnerRan: undefined,
    });
    const output = await this.operationRunner({
      operation: operation.name,
      phase: 'run',
      runnerAdapter,
      executionBackend: 'local',
      publicationMode: parsedArgs.publicationMode,
      target: {
        type: 'issue',
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
      reasoningEffort: readOptionalEnv(this.env.PULLOPS_REASONING_EFFORT),
      contextUsage: readContextUsage(this.env),
    });

    this.writeValidatedJson(output);
    return 0;
  }

  /**
   * @param {string[]} args
   * @returns {Promise<number>}
   */
  async runLocalPrdAutoCompleteReference(args) {
    const parsedArgs = parseLocalPrdAutomationReferenceArgs(args, 'prd:auto-complete');
    const operation = getWorkflowOperation('prd-auto-complete');
    if (operation === undefined) {
      throw new Error('prd-auto-complete operation is not registered.');
    }

    const config = await loadPullOpsConfig({ cwd: this.cwd });
    const operationConfig = config.operations[operation.configKey];
    const model = config.runner.models[operationConfig.modelTier];
    const runnerAdapter = config.runner.adapter;
    validateRunnerLifecycle({
      operationName: operation.name,
      phase: 'run',
      runnerAdapter,
      runnerRan: undefined,
    });
    const output = await this.operationRunner({
      operation: operation.name,
      phase: 'run',
      runnerAdapter,
      executionBackend: 'local',
      publicationMode: parsedArgs.publicationMode,
      target: {
        type: 'issue',
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
      reasoningEffort: readOptionalEnv(this.env.PULLOPS_REASONING_EFFORT),
      contextUsage: readContextUsage(this.env),
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
 * @param {string} reference
 * @returns {{ targetNumber: number, backend: 'github-actions' }}
 */
function parseGitHubActionsOperationLabelArgs(args, reference) {
  rejectGitHubActionsLocalOnlyFlag(args, '--publish');
  rejectGitHubActionsLocalOnlyFlag(args, '--until');

  const consumed = new Set();
  const backend = parseRequiredGitHubActionsBackend(args, reference, consumed);
  const remaining = args.filter((value, argIndex) => {
    void value;
    return !consumed.has(argIndex);
  });

  if (remaining.length === 0) {
    throw new CliUsageError(`Missing target number for ${reference}.`);
  }

  const [targetArgument, ...unknownArgs] = remaining;
  if (targetArgument === undefined || targetArgument.startsWith('--')) {
    throw new CliUsageError(
      `Unknown arguments for ${reference} with --backend github-actions: ${remaining.join(' ')}.`,
    );
  }

  if (unknownArgs.length > 0) {
    throw new CliUsageError(
      `Unknown arguments for ${reference} with --backend github-actions: ${unknownArgs.join(' ')}.`,
    );
  }

  const targetNumber = Number(targetArgument);
  if (!Number.isInteger(targetNumber) || targetNumber <= 0) {
    throw new CliUsageError('Target number must be a positive integer.');
  }

  return { targetNumber, backend };
}

/**
 * @param {string[]} args
 * @returns {string | undefined}
 */
function readOperationLabelBackend(args) {
  const index = args.indexOf('--backend');
  if (index === -1) {
    return undefined;
  }

  const rawBackend = args[index + 1];
  if (rawBackend === undefined || rawBackend.startsWith('--')) {
    throw new CliUsageError('Missing value for "--backend". Expected "local" or "github-actions".');
  }

  return rawBackend;
}

/**
 * @param {string[]} args
 * @returns {{
 *   targetNumber: number,
 *   publicationMode: 'dry-run' | 'publish',
 *   runGoal: import('./types.js').OperationRunGoal,
 * }}
 */
function parseLocalIssueImplementReferenceArgs(args) {
  const consumed = new Set();
  const rawBackend = parseOptionalStringOption(args, '--backend', consumed);
  if (rawBackend !== undefined && rawBackend !== 'local') {
    throw new CliUsageError(
      `Unknown backend "${rawBackend}" for issue:implement. Expected one of: local, github-actions.`,
    );
  }

  const runGoal = parseOperationRunGoal(args, consumed);
  const publicationMode = parsePublicationMode(args, consumed);
  const remaining = args.filter((value, argIndex) => {
    void value;
    return !consumed.has(argIndex);
  });

  if (remaining.length === 0) {
    throw new CliUsageError('Missing target number for issue:implement.');
  }

  const [targetArgument, ...unknownArgs] = remaining;
  if (targetArgument === undefined || targetArgument.startsWith('--')) {
    throw new CliUsageError(`Unknown arguments for issue:implement: ${remaining.join(' ')}.`);
  }

  if (unknownArgs.length > 0) {
    throw new CliUsageError(`Unknown arguments for issue:implement: ${unknownArgs.join(' ')}.`);
  }

  const targetNumber = Number(targetArgument);
  if (!Number.isInteger(targetNumber) || targetNumber <= 0) {
    throw new CliUsageError('Target number must be a positive integer.');
  }

  return {
    targetNumber,
    publicationMode,
    runGoal,
  };
}

/**
 * @param {string[]} args
 * @param {'prd:auto-advance' | 'prd:auto-complete'} reference
 * @returns {{
 *   targetNumber: number,
 *   publicationMode: 'dry-run' | 'publish',
 * }}
 */
function parseLocalPrdAutomationReferenceArgs(args, reference) {
  const consumed = new Set();
  const rawBackend = parseOptionalStringOption(args, '--backend', consumed);
  if (rawBackend !== undefined && rawBackend !== 'local') {
    throw new CliUsageError(
      `Unknown backend "${rawBackend}" for ${reference}. Expected one of: local, github-actions.`,
    );
  }

  const publicationMode = parsePublicationMode(args, consumed);
  const remaining = args.filter((value, argIndex) => {
    void value;
    return !consumed.has(argIndex);
  });

  if (remaining.length === 0) {
    throw new CliUsageError(`Missing target number for ${reference}.`);
  }

  const [targetArgument, ...unknownArgs] = remaining;
  if (targetArgument === undefined || targetArgument.startsWith('--')) {
    throw new CliUsageError(`Unknown arguments for ${reference}: ${remaining.join(' ')}.`);
  }

  if (unknownArgs.length > 0) {
    throw new CliUsageError(`Unknown arguments for ${reference}: ${unknownArgs.join(' ')}.`);
  }

  const targetNumber = Number(targetArgument);
  if (!Number.isInteger(targetNumber) || targetNumber <= 0) {
    throw new CliUsageError('Target number must be a positive integer.');
  }

  return {
    targetNumber,
    publicationMode,
  };
}

/**
 * @param {string[]} args
 * @param {string} reference
 * @returns {{ targetNumber: number }}
 */
function parseLocalPullRequestOperationReferenceArgs(args, reference) {
  const consumed = new Set();
  const rawBackend = parseOptionalStringOption(args, '--backend', consumed);
  if (rawBackend !== undefined && rawBackend !== 'local') {
    throw new CliUsageError(
      `Unknown backend "${rawBackend}" for ${reference}. Expected one of: local, github-actions.`,
    );
  }

  const remaining = args.filter((value, argIndex) => {
    void value;
    return !consumed.has(argIndex);
  });

  if (remaining.length === 0) {
    throw new CliUsageError(`Missing target number for ${reference}.`);
  }

  const [targetArgument, ...unknownArgs] = remaining;
  if (targetArgument === undefined || targetArgument.startsWith('--')) {
    throw new CliUsageError(`Unknown arguments for ${reference}: ${remaining.join(' ')}.`);
  }

  if (unknownArgs.length > 0) {
    throw new CliUsageError(`Unknown arguments for ${reference}: ${unknownArgs.join(' ')}.`);
  }

  const targetNumber = Number(targetArgument);
  if (!Number.isInteger(targetNumber) || targetNumber <= 0) {
    throw new CliUsageError('Target number must be a positive integer.');
  }

  return { targetNumber };
}

/**
 * @param {string[]} args
 * @param {Set<number>} consumed
 * @returns {'dry-run' | 'publish'}
 */
function parsePublicationMode(args, consumed) {
  const index = args.indexOf('--publish');
  if (index === -1) {
    return 'dry-run';
  }

  consumed.add(index);
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new CliUsageError('Missing value for "--publish". Expected "dry-run" or "pr".');
  }

  consumed.add(index + 1);

  if (value === 'dry-run') {
    return 'dry-run';
  }

  if (value !== 'pr') {
    throw new CliUsageError(
      'Unsupported publish target. Expected "--publish dry-run" or "--publish pr".',
    );
  }

  return 'publish';
}

/**
 * @param {string[]} args
 * @param {Set<number>} consumed
 * @returns {import('./types.js').OperationRunGoal}
 */
function parseOperationRunGoal(args, consumed) {
  const rawRunGoal = parseOptionalStringOption(args, '--until', consumed);
  if (rawRunGoal === undefined) {
    return 'operation';
  }

  if (rawRunGoal === 'operation' || rawRunGoal === 'finalized') {
    return rawRunGoal;
  }

  throw new CliUsageError(
    `Unsupported run goal "${rawRunGoal}". Expected "--until operation" or "--until finalized".`,
  );
}

/**
 * @param {string[]} args
 * @param {string} reference
 * @param {Set<number>} consumed
 * @returns {'github-actions'}
 */
function parseRequiredGitHubActionsBackend(args, reference, consumed) {
  const index = args.indexOf('--backend');
  if (index === -1) {
    throw new CliUsageError(
      `${reference} requires "--backend github-actions" to dispatch through GitHub Actions.`,
    );
  }

  const rawBackend = args[index + 1];
  if (rawBackend === undefined || rawBackend.startsWith('--')) {
    throw new CliUsageError('Missing value for "--backend". Expected "github-actions".');
  }

  consumed.add(index);
  consumed.add(index + 1);

  if (rawBackend !== 'github-actions') {
    throw new CliUsageError(
      `Unknown backend "${rawBackend}" for ${reference}. Expected "github-actions".`,
    );
  }

  return rawBackend;
}

/**
 * @param {string[]} args
 * @param {'--publish' | '--until'} flag
 */
function rejectGitHubActionsLocalOnlyFlag(args, flag) {
  if (args.includes(flag)) {
    throw new CliUsageError(
      `${flag} is only supported by the local execution backend and cannot be used with "--backend github-actions".`,
    );
  }
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
 * @param {NodeJS.ProcessEnv} env
 * @returns {import('./types.js').OperationContextUsage | undefined}
 */
function readContextUsage(env) {
  const used = readPositiveIntegerEnv(env.PULLOPS_CONTEXT_USED_TOKENS);
  const limit = readPositiveIntegerEnv(env.PULLOPS_CONTEXT_LIMIT_TOKENS);

  if (used === undefined || limit === undefined) {
    return undefined;
  }

  return { used, limit };
}

/**
 * @param {string | undefined} value
 * @returns {string | undefined}
 */
function readOptionalEnv(value) {
  if (value === undefined || value.trim() === '') {
    return undefined;
  }

  return value;
}

/**
 * @param {string | undefined} value
 * @returns {number | undefined}
 */
function readPositiveIntegerEnv(value) {
  if (value === undefined || value.trim() === '') {
    return undefined;
  }

  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    return undefined;
  }

  return number;
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
 * @param {string} value
 * @returns {boolean}
 */
function isOperationLabelReferenceInput(value) {
  return value.includes(':');
}

/**
 * @param {'issue' | 'pr'} target
 * @returns {string}
 */
function formatTargetKind(target) {
  return target === 'pr' ? 'pull request' : 'issue';
}

/**
 * @param {string} reference
 * @returns {string}
 */
function localOperationLabelReferenceUnsupportedMessage(reference) {
  return [
    `Local execution is currently only supported for: ${LOCAL_OPERATION_LABEL_REFERENCE_NAMES.join(', ')}.`,
    `Use "${reference} --backend github-actions" to dispatch the canonical PullOps label through GitHub Actions.`,
  ].join(' ');
}

/**
 * @returns {string}
 */
function usage() {
  return [
    'Usage:',
    '  pullops run issue:implement <issue-number> [--backend local] [--publish dry-run|pr] [--until operation|finalized]',
    '  pullops run prd:auto-advance <parent-issue-number> [--backend local] [--publish dry-run|pr]',
    '  pullops run prd:auto-complete <parent-issue-number> [--backend local] [--publish dry-run|pr]',
    '  pullops run pr:review|pr:address-review|pr:fix-ci|pr:update-branch|pr:resolve-conflicts|pr:finalize <pull-request-number> [--backend local]',
    '  pullops run <operation-label-reference> <target-number> --backend github-actions',
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
