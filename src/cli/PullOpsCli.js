import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

import { loadPullOpsConfig } from '../config/PullOpsConfig.js';
import { createGitClient } from '../git/GitClient.js';
import { createGitHubClient, parseGitHubRepository } from '../github/GitHubClient.js';
import {
  createIssueStoreRunRecordLocation,
  writeIssueStoreRunArtifact,
} from '../issue-store/localRunRecord.js';
import { publishChildIssues } from '../issue-store/publishChildIssues.js';
import { publishConcreteIssue } from '../issue-store/publishConcreteIssue.js';
import { publishPrdIssue } from '../issue-store/publishPrdIssue.js';
import { validateOperationOutput } from '../operation-output/OperationOutput.js';
import { runPullOpsInit } from '../setup/init.js';
import {
  runPullOpsSetupGitHubActions,
  runPullOpsSetupAgentDocs,
  runPullOpsSetupDoctor,
  runPullOpsSetupGitHubLabels,
  runPullOpsSetupSkills,
} from '../setup/setup.js';
import { hasSetupChanges } from '../setup/setupResult.js';
import {
  DEFAULT_LOCAL_RUN_HEARTBEAT_INTERVAL_MS,
  LocalRunHeartbeatError,
  readLocalRunState,
  recordLocalRunCompletedNonHeartbeatStep,
  recordLocalRunHeartbeat,
} from '../local-run-state/localRunState.js';
import {
  getOperationLabelReference,
  getWorkflowOperation,
  runWorkflowOperation,
} from '../operations/operations.js';
import {
  getOperationCatalogOperationLabelReferences,
  getOperationCatalogSupportedRunnerLifecycles,
  getOperationCatalogSupportedRunnerAdapters,
  getOperationCatalogSupportedRunnerPhases,
  getOperationCatalogWorkflowOperations,
} from '../operations/operationCatalog.js';
import {
  createLocalPrdAutoCompleteSummary,
  createOperationProgressEventWriter,
} from '../operations/prd-automation/eventStream.js';
import { publishHeartbeatToParentEventSink } from '../parent-event-sink/parentEventSink.js';
import { createLocalPrdRunRecordLocation } from '../prd-automation/localRunRecord.js';
import { createCodexRunner } from '../runner/CodexRunner.js';
import { isRunnerAdapter, RUNNER_ADAPTERS } from '../runner/runnerAdapters.js';
import {
  isRunnerResultStatus,
  RUNNER_RESULT_STATUSES,
  writeRunnerResult,
} from '../runner/runnerResult.js';

/**
 * @typedef {import('./types.js').WritableLike} WritableLike
 * @typedef {import('./types.js').OperationRunnerContext} OperationRunnerContext
 * @typedef {import('./types.js').OperationPhase} OperationPhase
 * @typedef {import('./types.js').OperationRunner} OperationRunner
 * @typedef {import('../runner/types.js').RunnerAdapter} RunnerAdapter
 * @typedef {import('../github/types.js').GitHubClient} GitHubClient
 * @typedef {import('../git/types.js').GitClient} GitClient
 * @typedef {import('../runner/types.js').CodexRunner} CodexRunner
 * @typedef {import('../issue-store/types.js').ChildIssuePublishFailureOutput} ChildIssuePublishFailureOutput
 * @typedef {import('../issue-store/types.js').ConcreteIssuePublishFailureOutput} ConcreteIssuePublishFailureOutput
 * @typedef {import('../issue-store/types.js').PrdIssuePublishFailureOutput} PrdIssuePublishFailureOutput
 * @typedef {(command: string, args: string[], options: import('node:child_process').SpawnOptions) => import('node:child_process').ChildProcess} StepCommandSpawner
 */

/**
 * @returns {readonly string[]}
 */
function readWorkflowOperationNames() {
  return getOperationCatalogWorkflowOperations().map(operation => operation.name);
}

/**
 * @param {() => GitHubClient} readClient
 * @returns {GitHubClient}
 */
function createLazyGitHubClient(readClient) {
  return /** @type {GitHubClient} */ (
    new Proxy(
      {},
      {
        get(_target, property) {
          if (property === Symbol.toStringTag) {
            return 'PullOpsLazyGitHubClient';
          }

          const client = readClient();
          const value = /** @type {Record<PropertyKey, unknown>} */ (
            /** @type {unknown} */ (client)
          )[property];
          return typeof value === 'function' ? value.bind(client) : value;
        },
      },
    )
  );
}

/**
 * @returns {readonly string[]}
 */
function readOperationLabelReferenceNames() {
  return getOperationCatalogOperationLabelReferences().map(operation => operation.reference);
}

/**
 * @returns {readonly string[]}
 */
function readLocalOperationLabelReferenceNames() {
  const operationLabelReferenceNames = readOperationLabelReferenceNames();
  return [
    'issue:implement',
    ...operationLabelReferenceNames.filter(
      reference => reference !== 'prd:prepare' && reference !== 'issue:implement',
    ),
  ];
}

/** @type {import('../operation-output/types.js').OperationOutputContract} */
const COMMAND_OUTPUT_CONTRACT = {
  required: {
    status: 'string',
    summary: 'string',
  },
};
const STEP_USAGE = 'Usage: pullops step [--long] "<summary>" -- <command...>';
const COMPLETED_NON_HEARTBEAT_STEPS_BEFORE_HEARTBEAT = 3;

export class PullOpsCli {
  /**
   * @param {object} [options]
   * @param {string} [options.cwd]
   * @param {WritableLike} [options.stdout]
   * @param {WritableLike} [options.stderr]
   * @param {NodeJS.ReadableStream} [options.stdin]
   * @param {GitHubClient} [options.githubClient]
   * @param {GitClient} [options.gitClient]
   * @param {CodexRunner} [options.codexRunner]
   * @param {OperationRunner} [options.operationRunner]
   * @param {NodeJS.ProcessEnv} [options.env]
   * @param {StepCommandSpawner} [options.spawnCommand]
   * @param {() => Date} [options.now]
   */
  constructor({
    cwd = process.cwd(),
    stdout = process.stdout,
    stderr = process.stderr,
    stdin = process.stdin,
    githubClient,
    gitClient,
    codexRunner,
    operationRunner = runWorkflowOperation,
    env = process.env,
    spawnCommand = spawn,
    now = () => new Date(),
  } = {}) {
    this.cwd = cwd;
    this.stdout = stdout;
    this.stderr = stderr;
    this.stdin = stdin;
    this.providedGitHubClient = githubClient;
    this.defaultGitHubClient = githubClient;
    /** @type {GitHubClient | undefined} */
    this.defaultOperationGitHubClient = undefined;
    /** @type {(message: string) => void} */
    this.progress = message => {
      this.stderr.write(`[pullops] ${message}\n`);
    };
    this.gitClient =
      gitClient ??
      createGitClient({
        env,
        traceCommand: command => {
          this.progress(`git: ${command}`);
        },
      });
    this.codexRunner =
      codexRunner ??
      createCodexRunner({
        output: this.stderr,
        traceCommand: command => {
          this.progress(`runner: ${command}`);
        },
      });
    this.operationRunner = operationRunner;
    this.env = env;
    this.spawnCommand = spawnCommand;
    this.now = now;
  }

  /**
   * @returns {GitHubClient}
   */
  get githubClient() {
    this.defaultGitHubClient ??= createGitHubClient();
    return this.defaultGitHubClient;
  }

  /**
   * @returns {GitHubClient}
   */
  get operationGitHubClient() {
    this.defaultOperationGitHubClient ??= createLazyGitHubClient(() => this.githubClient);
    return this.defaultOperationGitHubClient;
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

    if (command === 'issues') {
      return await this.runIssues(args);
    }

    if (command === 'heartbeat') {
      return await this.runHeartbeat(args);
    }

    if (command === 'runner-result') {
      return await this.runRunnerResult(args);
    }

    if (command === 'init') {
      return await this.runInit(args);
    }

    if (command === 'setup') {
      return await this.runSetup(args);
    }

    if (command === 'step') {
      return await this.runStep(args);
    }

    throw new CliUsageError(`Unknown command "${command}".\n\n${usage()}`);
  }

  /**
   * @param {string[]} args
   * @returns {Promise<number>}
   */
  async runStep(args) {
    const parsedArgs = parseStepArgs(args);
    const statePath = this.readRequiredStepStatePath();
    const token = this.readRequiredStepHeartbeatToken(statePath);
    const firstHeartbeat = await this.recordStepHeartbeatIfDue({
      force: parsedArgs.long,
      statePath,
      token,
      summary: parsedArgs.summary,
    });
    const periodicHeartbeats = parsedArgs.long
      ? this.startLongStepHeartbeats({
          statePath,
          token,
          summary: parsedArgs.summary,
          intervalMs: firstHeartbeat.heartbeatIntervalMs,
        })
      : undefined;

    let exitCode;
    try {
      exitCode = await this.runWrappedCommand(parsedArgs.command);
    } finally {
      await periodicHeartbeats?.stop();
    }

    if (!firstHeartbeat.emitted) {
      await this.recordCompletedNonHeartbeatStep(statePath);
    }

    return exitCode;
  }

  /**
   * @returns {string}
   */
  readRequiredStepStatePath() {
    const statePath = readOptionalEnv(this.env.PULLOPS_RUN_STATE_PATH);
    if (statePath === undefined) {
      throw new LocalRunHeartbeatError('Missing run state path for pullops step.');
    }

    return resolve(this.cwd, statePath);
  }

  /**
   * @param {string} statePath
   * @returns {string}
   */
  readRequiredStepHeartbeatToken(statePath) {
    const token = readOptionalEnv(this.env.PULLOPS_HEARTBEAT_TOKEN);
    if (token === undefined) {
      throw new LocalRunHeartbeatError(`Missing heartbeat token for ${statePath}.`);
    }

    return token;
  }

  /**
   * @param {{
   *   force: boolean,
   *   statePath: string,
   *   token: string,
   *   summary: string,
   * }} options
   * @returns {Promise<{ emitted: boolean, heartbeatIntervalMs: number }>}
   */
  async recordStepHeartbeatIfDue({ force, statePath, token, summary }) {
    const state = await readLocalRunState(statePath);
    const heartbeatIntervalMs = readStepHeartbeatIntervalMs(state);
    if (!isStepHeartbeatDue(state, { force, now: this.now(), heartbeatIntervalMs })) {
      return { emitted: false, heartbeatIntervalMs };
    }

    const sinkDelivery = await this.recordLocalRunHeartbeatAndPublish({
      statePath,
      token,
      summary,
      at: this.now(),
    });
    this.writeParentEventSinkWarning(sinkDelivery.warning);
    const updated = sinkDelivery.runState;
    return {
      emitted: true,
      heartbeatIntervalMs: readStepHeartbeatIntervalMs(updated),
    };
  }

  /**
   * @param {{
   *   statePath: string,
   *   token: string,
   *   summary: string,
   *   intervalMs: number,
   * }} options
   * @returns {{ stop: () => Promise<void> }}
   */
  startLongStepHeartbeats({ statePath, token, summary, intervalMs }) {
    /** @type {Promise<void>} */
    let heartbeatWrite = Promise.resolve();
    const timer = setInterval(() => {
      heartbeatWrite = heartbeatWrite
        .catch(() => undefined)
        .then(async () => {
          const sinkDelivery = await this.recordLocalRunHeartbeatAndPublish({
            statePath,
            token,
            summary,
            at: this.now(),
          });
          this.writeParentEventSinkWarning(sinkDelivery.warning);
        })
        .catch(error => {
          this.writeError(`[pullops] step heartbeat failed: ${getErrorMessage(error)}`);
        });
    }, intervalMs);

    return {
      stop: async () => {
        clearInterval(timer);
        await heartbeatWrite.catch(() => undefined);
      },
    };
  }

  /**
   * @param {string} statePath
   * @returns {Promise<void>}
   */
  async recordCompletedNonHeartbeatStep(statePath) {
    try {
      await recordLocalRunCompletedNonHeartbeatStep({ statePath });
    } catch (error) {
      this.writeError(`[pullops] failed to record completed step: ${getErrorMessage(error)}`);
    }
  }

  /**
   * @param {string[]} command
   * @returns {Promise<number>}
   */
  async runWrappedCommand(command) {
    const [executable, ...args] = command;
    if (executable === undefined) {
      throw new CliUsageError(STEP_USAGE);
    }

    const child = this.spawnCommand(executable, args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ['inherit', 'pipe', 'pipe'],
    });

    child.stdout?.on('data', chunk => {
      this.stdout.write(chunk);
    });
    child.stderr?.on('data', chunk => {
      this.stderr.write(chunk);
    });

    return await new Promise((resolvePromise, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => {
        resolvePromise(readWrappedCommandExitCode(code, signal));
      });
    });
  }

  /**
   * @param {string[]} args
   * @returns {Promise<number>}
   */
  async runHeartbeat(args) {
    /** @type {{ statePath?: string, token?: string, summary?: string } | undefined} */
    let parsedArgs;
    /** @type {string | undefined} */
    let statePath;

    try {
      parsedArgs = parseHeartbeatArgs(args, this.env);
      if (parsedArgs.statePath === undefined) {
        throw new CliUsageError(
          'Missing run state path. Expected "--state <path>" or PULLOPS_RUN_STATE_PATH.',
        );
      }

      statePath = resolve(this.cwd, parsedArgs.statePath);
      const localRunRecord = dirname(statePath);
      if (parsedArgs.token === undefined) {
        throw new LocalRunHeartbeatError(`Missing heartbeat token for ${statePath}.`);
      }

      const sinkDelivery = await this.recordLocalRunHeartbeatAndPublish({
        statePath,
        token: parsedArgs.token,
        summary: parsedArgs.summary,
      });
      this.writeValidatedJson({
        status: 'accepted',
        summary: `Recorded heartbeat for ${localRunRecord}.`,
        localRunRecord,
        runStatePath: statePath,
        runState: sinkDelivery.runState,
        ...(sinkDelivery.warning === undefined ? {} : { warnings: [sinkDelivery.warning] }),
      });
      return 0;
    } catch (error) {
      const message = getErrorMessage(error);
      const localRunRecord = statePath === undefined ? undefined : dirname(statePath);
      this.writeValidatedJson({
        status: error instanceof LocalRunHeartbeatError ? 'refused' : 'failed',
        summary: message,
        ...(localRunRecord === undefined ? {} : { localRunRecord }),
        ...(statePath === undefined ? {} : { runStatePath: statePath }),
      });
      return 1;
    }
  }

  /**
   * @param {string[]} args
   * @returns {Promise<number>}
   */
  async runRunnerResult(args) {
    const parsedArgs = parseRunnerResultArgs(args);
    const result = await writeRunnerResult({
      cwd: this.cwd,
      status: parsedArgs.status,
      outputDirectory: this.env.OUTPUT_DIR,
      ...(parsedArgs.filePath === undefined ? {} : { resultFile: parsedArgs.filePath }),
    });

    this.writeValidatedJson({
      status: 'accepted',
      summary: `Wrote external runner result to ${result.resultFile}.`,
      runnerResult: {
        status: result.result.status,
        resultFile: result.resultFile,
      },
    });
    return 0;
  }

  /**
   * @param {import('../local-run-state/types.js').RecordLocalRunHeartbeatOptions} options
   * @returns {Promise<{
   *   runState: import('../local-run-state/types.js').LocalRunState,
   *   warning?: string,
   * }>}
   */
  async recordLocalRunHeartbeatAndPublish(options) {
    const runState = await recordLocalRunHeartbeat(options);
    const sinkDelivery = await publishHeartbeatToParentEventSink({
      env: this.env,
      localRunRecord: dirname(options.statePath),
      runState,
    });
    return {
      runState,
      ...(sinkDelivery.warning === undefined ? {} : { warning: sinkDelivery.warning }),
    };
  }

  /**
   * @param {string | undefined} warning
   * @returns {void}
   */
  writeParentEventSinkWarning(warning) {
    if (warning !== undefined) {
      this.writeError(`[pullops] ${warning}`);
    }
  }

  /**
   * @param {string[]} args
   * @returns {Promise<number>}
   */
  async runIssues(args) {
    const [subcommand, ...rest] = args;

    if (subcommand === undefined) {
      throw new CliUsageError(
        'Missing issues subcommand. Expected one of: publish-prd, publish-children, publish-issue.',
      );
    }

    if (subcommand === 'publish-prd') {
      return await this.runPublishPrd(rest);
    }

    if (subcommand === 'publish-children') {
      return await this.runPublishChildren(rest);
    }

    if (subcommand === 'publish-issue') {
      return await this.runPublishIssue(rest);
    }

    throw new CliUsageError(
      `Unknown issues subcommand "${subcommand}". Expected one of: publish-prd, publish-children, publish-issue.`,
    );
  }

  /**
   * @param {string[]} args
   * @returns {Promise<number>}
   */
  async runPublishPrd(args) {
    const createdAt = new Date();
    let rawRequest = '';

    try {
      const parsedArgs = parsePublishPrdArgs(args);
      rawRequest = await readPublishPrdInput({
        cwd: this.cwd,
        filePath: parsedArgs.filePath,
        stdin: this.stdin,
      });
      const config = await loadPullOpsConfig({ cwd: this.cwd });
      const output = await publishPrdIssue({
        cwd: this.cwd,
        config,
        githubClient: this.githubClient,
        rawRequest,
        createdAt,
      });

      this.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
      return output.status === 'accepted' ? 0 : 1;
    } catch (error) {
      const output = await writePublishPrdFailure({
        cwd: this.cwd,
        createdAt,
        rawRequest,
        failureReason: getErrorMessage(error),
      });
      this.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
      return 1;
    }
  }

  /**
   * @param {string[]} args
   * @returns {Promise<number>}
   */
  async runPublishIssue(args) {
    const createdAt = new Date();
    let rawRequest = '';

    try {
      const parsedArgs = parsePublishIssueArgs(args);
      rawRequest = await readPublishIssueInput({
        cwd: this.cwd,
        filePath: parsedArgs.filePath,
        stdin: this.stdin,
      });
      const config = await loadPullOpsConfig({ cwd: this.cwd });
      const output = await publishConcreteIssue({
        cwd: this.cwd,
        config,
        githubClient: this.githubClient,
        rawRequest,
        createdAt,
      });

      this.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
      return output.status === 'accepted' ? 0 : 1;
    } catch (error) {
      const output = await writePublishIssueFailure({
        cwd: this.cwd,
        createdAt,
        rawRequest,
        failureReason: getErrorMessage(error),
      });
      this.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
      return 1;
    }
  }

  /**
   * @param {string[]} args
   * @returns {Promise<number>}
   */
  async runPublishChildren(args) {
    const createdAt = new Date();
    let rawRequest = '';

    try {
      const parsedArgs = parsePublishChildrenArgs(args);
      rawRequest = await readPublishChildrenInput({
        cwd: this.cwd,
        filePath: parsedArgs.filePath,
        stdin: this.stdin,
      });
      const config = await loadPullOpsConfig({ cwd: this.cwd });
      const output = await publishChildIssues({
        cwd: this.cwd,
        config,
        githubClient: this.githubClient,
        rawRequest,
        parentIssueNumber: parsedArgs.parentIssueNumber,
        forceUpdate: parsedArgs.forceUpdate,
        createdAt,
      });

      this.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
      return output.status === 'accepted' ? 0 : 1;
    } catch (error) {
      const output = await writePublishChildrenFailure({
        cwd: this.cwd,
        createdAt,
        rawRequest,
        failureReason: getErrorMessage(error),
      });
      this.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
      return 1;
    }
  }

  /**
   * @param {string[]} args
   * @returns {Promise<number>}
   */
  async runOperation(args) {
    const [operationName, ...operationArgs] = args;

    if (operationName === undefined) {
      throw new CliUsageError(
        `Missing operation. Expected one of: ${readWorkflowOperationNames().join(', ')}.`,
      );
    }

    if (isOperationLabelReferenceInput(operationName)) {
      return await this.runOperationLabelReference(operationName, operationArgs);
    }

    const operation = getWorkflowOperation(operationName);
    if (operation === undefined) {
      throw new CliUsageError(
        `Unknown operation "${operationName}". Expected one of: ${readWorkflowOperationNames().join(
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
      githubClient: this.operationGitHubClient,
      gitClient: this.gitClient,
      codexRunner: this.codexRunner,
      triggerActor: this.env.GITHUB_ACTOR,
      reviewId: parsedArgs.reviewId,
      outputDirectory: this.env.OUTPUT_DIR,
      reasoningEffort: readOptionalEnv(this.env.PULLOPS_REASONING_EFFORT),
      contextUsage: readContextUsage(this.env),
    });

    this.writeValidatedJson(output);
    return readOperationExitCode(output);
  }

  /**
   * @param {string} reference
   * @param {string[]} args
   * @returns {Promise<number>}
   */
  async runOperationLabelReference(reference, args) {
    if (reference.startsWith('pullops:')) {
      throw new CliUsageError(
        `Full PullOps labels are not accepted as operation references. Expected one of: ${readOperationLabelReferenceNames().join(
          ', ',
        )}.`,
      );
    }

    const operation = getOperationLabelReference(reference);
    if (operation === undefined) {
      throw new CliUsageError(
        `Unknown operation label reference "${reference}". Expected one of: ${readOperationLabelReferenceNames().join(
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

    if (operation.workflowOperationName === 'issue-implement') {
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
    });
    const output = await this.operationRunner({
      operation: workflowOperation.name,
      phase: 'run',
      runnerAdapter,
      executionBackend: 'local',
      publicationMode: 'dry-run',
      target: {
        type: 'pr',
        number: parsedArgs.targetNumber,
      },
      cwd: this.cwd,
      config,
      modelTier: operationConfig.modelTier,
      model,
      githubClient: this.operationGitHubClient,
      gitClient: this.gitClient,
      codexRunner: this.codexRunner,
      triggerActor: this.env.GITHUB_ACTOR,
      reasoningEffort: readOptionalEnv(this.env.PULLOPS_REASONING_EFFORT),
      contextUsage: readContextUsage(this.env),
      progress: this.progress,
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
      githubClient: this.operationGitHubClient,
      gitClient: this.gitClient,
      codexRunner: this.codexRunner,
      triggerActor: this.env.GITHUB_ACTOR,
      reasoningEffort: readOptionalEnv(this.env.PULLOPS_REASONING_EFFORT),
      contextUsage: readContextUsage(this.env),
      progress: this.progress,
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
      githubClient: this.operationGitHubClient,
      gitClient: this.gitClient,
      codexRunner: this.codexRunner,
      triggerActor: this.env.GITHUB_ACTOR,
      reasoningEffort: readOptionalEnv(this.env.PULLOPS_REASONING_EFFORT),
      contextUsage: readContextUsage(this.env),
      progress: this.progress,
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
    const contextUsage = readContextUsage(this.env);
    const startedAt = new Date();
    const localRunRecordLocation =
      parsedArgs.eventsFormat === 'jsonl'
        ? createLocalPrdRunRecordLocation({
            cwd: this.cwd,
            operationReference: 'prd:auto-complete',
            targetNumber: parsedArgs.targetNumber,
            createdAt: startedAt,
          })
        : undefined;
    const progressEventWriter =
      localRunRecordLocation === undefined
        ? undefined
        : createOperationProgressEventWriter({
            stdout: this.stdout,
            operation: operation.name,
            operationLabelReference: readRequiredOperationLabelReference('prd:auto-complete'),
            runId: localRunRecordLocation.runId,
            target: {
              type: 'issue',
              number: parsedArgs.targetNumber,
            },
          });
    validateRunnerLifecycle({
      operationName: operation.name,
      phase: 'run',
      runnerAdapter,
    });
    try {
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
        githubClient: this.operationGitHubClient,
        gitClient: this.gitClient,
        codexRunner: this.codexRunner,
        triggerActor: this.env.GITHUB_ACTOR,
        reasoningEffort: readOptionalEnv(this.env.PULLOPS_REASONING_EFFORT),
        contextUsage,
        progress: this.progress,
        ...(localRunRecordLocation === undefined
          ? {}
          : { localRunRecordDirectory: localRunRecordLocation.directory }),
        ...(progressEventWriter === undefined ? {} : { progressEventWriter }),
      });

      if (parsedArgs.eventsFormat === 'jsonl') {
        await this.emitLocalPrdAutoCompleteSummary(progressEventWriter, output, {
          startedAt,
          finishedAt: new Date(),
          contextUsage,
          operationLabelReference: readRequiredOperationLabelReference('prd:auto-complete'),
          target: {
            type: 'issue',
            number: parsedArgs.targetNumber,
          },
        });
        return readOperationExitCode(output);
      }

      this.writeValidatedJson(output);
      return readOperationExitCode(output);
    } catch (error) {
      if (parsedArgs.eventsFormat !== 'jsonl') {
        throw error;
      }

      const localRunRecord =
        readLocalRunRecordFromError(error) ?? localRunRecordLocation?.directory;
      if (localRunRecord === undefined) {
        throw error;
      }

      await mkdir(localRunRecord, { recursive: true });
      await progressEventWriter?.bindLocalRunRecord(localRunRecord);
      const errorOutput =
        readKnownLocalPrdRunBoundaryOutput(error, { localRunRecord }) ??
        createLocalPrdAutoCompleteFailureOutput({
          error,
          localRunRecord,
          targetNumber: parsedArgs.targetNumber,
          publicationMode: parsedArgs.publicationMode,
        });
      await this.emitLocalPrdAutoCompleteSummary(progressEventWriter, errorOutput, {
        startedAt,
        finishedAt: new Date(),
        contextUsage,
        operationLabelReference: readRequiredOperationLabelReference('prd:auto-complete'),
        target: {
          type: 'issue',
          number: parsedArgs.targetNumber,
        },
      });
      return readOperationExitCode(errorOutput);
    }
  }

  /**
   * @param {string[]} args
   * @returns {Promise<number>}
   */
  async runSetup(args) {
    const [subcommand, ...rest] = args;

    if (subcommand === undefined) {
      throw new CliUsageError(
        'Missing setup subcommand. Expected one of: doctor, skills, agent-docs, github-actions, github-labels.',
      );
    }

    if (subcommand === '--help' || subcommand === '-h') {
      this.stdout.write(`${usage()}\n`);
      return 0;
    }

    if (subcommand === 'doctor') {
      return await this.runSetupDoctor(rest);
    }

    if (subcommand === 'skills') {
      return await this.runSetupSkills(rest);
    }

    if (subcommand === 'agent-docs') {
      return await this.runSetupAgentDocs(rest);
    }

    if (subcommand === 'github-actions') {
      return await this.runSetupGitHubActions(rest);
    }

    if (subcommand === 'github-labels') {
      return await this.runSetupGitHubLabels(rest);
    }

    throw new CliUsageError(
      `Unknown setup subcommand "${subcommand}". Expected one of: doctor, skills, agent-docs, github-actions, github-labels.`,
    );
  }

  /**
   * @param {string[]} args
   * @returns {Promise<number>}
   */
  async runSetupDoctor(args) {
    const parsedArgs = parseSetupDoctorArgs(args);
    const result = await runPullOpsSetupDoctor({
      cwd: this.cwd,
      profile: parsedArgs.profile,
      ...(parsedArgs.repo === undefined ? {} : { repository: parsedArgs.repo }),
    });

    if (parsedArgs.json) {
      this.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      this.stdout.write(`${renderSetupDoctorResult(result, parsedArgs.profile)}\n`);
    }

    return readSetupExitCode({ result, check: parsedArgs.check });
  }

  /**
   * @param {string[]} args
   * @returns {Promise<number>}
   */
  async runSetupSkills(args) {
    const parsedArgs = parseSetupArgs(args);
    const result = await runPullOpsSetupSkills({
      cwd: this.cwd,
      check: parsedArgs.check,
      force: parsedArgs.force,
    });

    if (parsedArgs.json) {
      this.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      this.stdout.write(`${renderSetupResult(result)}\n`);
    }

    return readSetupExitCode({ result, check: parsedArgs.check });
  }

  /**
   * @param {string[]} args
   * @returns {Promise<number>}
   */
  async runSetupAgentDocs(args) {
    const parsedArgs = parseSetupArgs(args);
    const result = await runPullOpsSetupAgentDocs({
      cwd: this.cwd,
      check: parsedArgs.check,
      force: parsedArgs.force,
    });

    if (parsedArgs.json) {
      this.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      this.stdout.write(`${renderSetupResult(result)}\n`);
    }

    return readSetupExitCode({ result, check: parsedArgs.check });
  }

  /**
   * @param {string[]} args
   * @returns {Promise<number>}
   */
  async runSetupGitHubActions(args) {
    const parsedArgs = parseSetupArgs(args);
    const result = await runPullOpsSetupGitHubActions({
      cwd: this.cwd,
      check: parsedArgs.check,
      force: parsedArgs.force,
    });

    if (parsedArgs.json) {
      this.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      this.stdout.write(`${renderSetupResult(result)}\n`);
    }

    return readSetupExitCode({ result, check: parsedArgs.check });
  }

  /**
   * @param {string[]} args
   * @returns {Promise<number>}
   */
  async runSetupGitHubLabels(args) {
    const parsedArgs = parseSetupGitHubLabelsArgs(args);
    const result = await runPullOpsSetupGitHubLabels({
      cwd: this.cwd,
      check: parsedArgs.check,
      force: parsedArgs.force,
      ...(this.providedGitHubClient === undefined
        ? {}
        : { githubClient: this.providedGitHubClient }),
      ...(parsedArgs.repo === undefined ? {} : { repository: parsedArgs.repo }),
    });

    if (parsedArgs.json) {
      this.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      this.stdout.write(`${renderSetupResult(result)}\n`);
    }

    return readSetupExitCode({ result, check: parsedArgs.check });
  }

  /**
   * @param {string[]} args
   * @returns {Promise<number>}
   */
  async runInit(args) {
    const parsedArgs = parseInitArgs(args);
    const result = await runPullOpsInit({
      cwd: this.cwd,
      check: parsedArgs.check,
      force: parsedArgs.force,
    });

    if (parsedArgs.json) {
      this.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      this.stdout.write(`${renderInitResult(result)}\n`);
    }

    return readSetupExitCode({ result, check: parsedArgs.check });
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
   * @param {import('./types.js').OperationProgressEventWriter | undefined} progressEventWriter
   * @param {unknown} output
   * @param {{
   *   startedAt: Date,
   *   finishedAt: Date,
   *   contextUsage?: import('./types.js').OperationContextUsage,
   *   operationLabelReference: string,
   *   target: { type: 'issue', number: number },
   * }} options
   * @returns {Promise<void>}
   */
  async emitLocalPrdAutoCompleteSummary(
    progressEventWriter,
    output,
    { startedAt, finishedAt, contextUsage, operationLabelReference, target },
  ) {
    const result = validateOperationOutput(output, COMMAND_OUTPUT_CONTRACT);
    if (!result.valid) {
      throw new Error(`Invalid Operation Output: ${result.reason}`);
    }

    if (progressEventWriter === undefined) {
      throw new Error('Progress event writer is required for JSONL event streams.');
    }

    const summary = createLocalPrdAutoCompleteSummary(
      /** @type {import('../prd-automation/childCoordination.types.js').PrdAutomationResult} */ (
        result.value
      ),
      {
        operationLabelReference,
        target,
        startedAt,
        finishedAt,
        contextUsage,
      },
    );
    await progressEventWriter.emit('run.summary', summary);
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
 * @returns {{
 *   targetNumber: number,
 *   phase: OperationPhase,
 *   runnerAdapter: RunnerAdapter,
 *   reviewId?: string,
 * }}
 */
function parseRunOperationArgs(args, operation, defaultRunnerAdapter) {
  const consumed = new Set();
  const targetNumber = parseRequiredNumberOption(args, operation.option, operation.name, consumed);
  const phase = parseOperationPhase(args, consumed);
  const runnerAdapter = parseRunnerAdapter(args, defaultRunnerAdapter, consumed);
  const reviewId =
    operation.name === 'pr-address-review'
      ? parseOptionalStringOption(args, '--review-id', consumed)
      : undefined;

  validateRunnerLifecycle({ operationName: operation.name, phase, runnerAdapter });

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
    ...(reviewId === undefined ? {} : { reviewId }),
  };
}

/**
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ statePath?: string, token?: string, summary?: string }}
 */
function parseHeartbeatArgs(args, env) {
  const consumed = new Set();
  const statePath =
    parseOptionalStringOption(args, '--state', consumed) ??
    readOptionalEnv(env.PULLOPS_RUN_STATE_PATH);
  const token =
    parseOptionalStringOption(args, '--token', consumed) ??
    readOptionalEnv(env.PULLOPS_HEARTBEAT_TOKEN);
  const summary = parseOptionalStringOption(args, '--summary', consumed);

  const remaining = args.filter((value, argIndex) => {
    void value;
    return !consumed.has(argIndex);
  });
  if (remaining.length > 0) {
    throw new CliUsageError(`Unknown arguments for heartbeat: ${remaining.join(' ')}.`);
  }

  return {
    ...(statePath === undefined ? {} : { statePath }),
    ...(token === undefined ? {} : { token }),
    ...(summary === undefined ? {} : { summary }),
  };
}

/**
 * @param {string[]} args
 * @returns {{ check: boolean, json: boolean, force: boolean }}
 */
function parseInitArgs(args) {
  const consumed = new Set();
  const check = parseBooleanFlag(args, '--check', consumed);
  const json = parseBooleanFlag(args, '--json', consumed);
  const force = parseBooleanFlag(args, '--force', consumed);

  const remaining = args.filter((value, argIndex) => {
    void value;
    return !consumed.has(argIndex);
  });

  if (remaining.length > 0) {
    throw new CliUsageError(`Unknown arguments for init: ${remaining.join(' ')}.`);
  }

  return {
    check,
    json,
    force,
  };
}

/**
 * @param {string[]} args
 * @returns {{ check: boolean, json: boolean, force: boolean }}
 */
function parseSetupArgs(args) {
  const consumed = new Set();
  const check = parseBooleanFlag(args, '--check', consumed);
  const json = parseBooleanFlag(args, '--json', consumed);
  const force = parseBooleanFlag(args, '--force', consumed);

  const remaining = args.filter((value, argIndex) => {
    void value;
    return !consumed.has(argIndex);
  });

  if (remaining.length > 0) {
    throw new CliUsageError(`Unknown arguments for setup command: ${remaining.join(' ')}.`);
  }

  return {
    check,
    json,
    force,
  };
}

/**
 * @param {string[]} args
 * @returns {{ check: boolean, json: boolean, force: boolean, repo?: string }}
 */
function parseSetupGitHubLabelsArgs(args) {
  const consumed = new Set();
  const check = parseBooleanFlag(args, '--check', consumed);
  const json = parseBooleanFlag(args, '--json', consumed);
  const force = parseBooleanFlag(args, '--force', consumed);
  const repo = parseOptionalStringOption(args, '--repo', consumed);

  if (repo !== undefined) {
    parseGitHubRepository(repo);
  }

  const remaining = args.filter((value, argIndex) => {
    void value;
    return !consumed.has(argIndex);
  });

  if (remaining.length > 0) {
    throw new CliUsageError(`Unknown arguments for setup github-labels: ${remaining.join(' ')}.`);
  }

  return {
    check,
    json,
    force,
    ...(repo === undefined ? {} : { repo }),
  };
}

/**
 * @param {string[]} args
 * @returns {{ check: boolean, json: boolean, force: boolean, profile: import('../setup/setup.types.js').PullOpsSetupProfile, repo?: string }}
 */
function parseSetupDoctorArgs(args) {
  const consumed = new Set();
  const check = parseBooleanFlag(args, '--check', consumed);
  const json = parseBooleanFlag(args, '--json', consumed);
  const force = parseBooleanFlag(args, '--force', consumed);
  const rawProfile = parseOptionalStringOption(args, '--profile', consumed) ?? 'full';
  const repo = parseOptionalStringOption(args, '--repo', consumed);

  if (!['full', 'local', 'authoring', 'github-actions'].includes(rawProfile)) {
    throw new CliUsageError(
      `Unsupported setup doctor profile "${rawProfile}". Expected one of: full, local, authoring, github-actions.`,
    );
  }
  const profile = /** @type {import('../setup/setup.types.js').PullOpsSetupProfile} */ (rawProfile);

  if (repo !== undefined) {
    parseGitHubRepository(repo);
  }

  const remaining = args.filter((value, argIndex) => {
    void value;
    return !consumed.has(argIndex);
  });

  if (remaining.length > 0) {
    throw new CliUsageError(`Unknown arguments for setup doctor: ${remaining.join(' ')}.`);
  }

  return {
    check,
    json,
    force,
    profile,
    ...(repo === undefined ? {} : { repo }),
  };
}

/**
 * @param {import('../setup/init.types.js').PullOpsSetupResult} result
 * @returns {string}
 */
function renderInitResult(result) {
  const lines = [
    `PullOps Init: ${result.status}`,
    `Area: ${result.area}`,
    `Summary: ${result.summary}`,
  ];

  appendSetupChangeSection(lines, 'Changes', result.changes);
  appendSetupChangeSection(lines, 'Changes needed', result.changesNeeded);
  appendSetupSection(lines, 'Blockers', result.blockers);
  appendSetupSection(lines, 'Warnings', result.warnings);
  appendSetupSection(lines, 'Suggestions', result.suggestions);

  return lines.join('\n');
}

/**
 * @param {import('../setup/init.types.js').PullOpsSetupResult} result
 * @returns {string}
 */
function renderSetupResult(result) {
  const lines = [
    `PullOps Setup: ${result.status}`,
    `Area: ${result.area}`,
    `Summary: ${result.summary}`,
  ];

  appendSetupChangeSection(lines, 'Changes', result.changes);
  appendSetupChangeSection(lines, 'Changes needed', result.changesNeeded);
  appendSetupSection(lines, 'Blockers', result.blockers);
  appendSetupSection(lines, 'Warnings', result.warnings);
  appendSetupSection(lines, 'Suggestions', result.suggestions);

  return lines.join('\n');
}

/**
 * @param {import('../setup/init.types.js').PullOpsSetupResult} result
 * @param {import('../setup/setup.types.js').PullOpsSetupProfile} profile
 * @returns {string}
 */
function renderSetupDoctorResult(result, profile) {
  return ['Profile: ' + profile, renderSetupResult(result)].join('\n');
}

/**
 * @param {{
 *   result: import('../setup/init.types.js').PullOpsSetupResult,
 *   check: boolean,
 * }} options
 * @returns {number}
 */
function readSetupExitCode({ result, check }) {
  if (result.status === 'blocked') {
    return 1;
  }

  if (check && hasSetupChanges(result.changesNeeded)) {
    return 1;
  }

  return 0;
}

/**
 * @param {string[]} lines
 * @param {string} heading
 * @param {import('../setup/init.types.js').PullOpsSetupChangeSet} changeSet
 */
function appendSetupChangeSection(lines, heading, changeSet) {
  const items = [
    ...(changeSet.files ?? []),
    ...(changeSet.labels?.created ?? []).map(label => `label created: ${label}`),
    ...(changeSet.labels?.updated ?? []).map(label => `label updated: ${label}`),
  ];
  appendSetupSection(lines, heading, items);
}

/**
 * @param {string[]} lines
 * @param {string} heading
 * @param {string[]} items
 */
function appendSetupSection(lines, heading, items) {
  if (items.length === 0) {
    return;
  }

  lines.push(`${heading}:`);
  for (const item of items) {
    lines.push(`- ${item}`);
  }
}

/**
 * @param {string[]} args
 * @returns {{ long: boolean, summary: string, command: string[] }}
 */
function parseStepArgs(args) {
  const separatorIndex = args.indexOf('--');
  if (separatorIndex === -1) {
    throw new CliUsageError(STEP_USAGE);
  }

  const command = args.slice(separatorIndex + 1);
  if (command.length === 0) {
    throw new CliUsageError(STEP_USAGE);
  }

  let long = false;
  const summaryArgs = [];
  for (const arg of args.slice(0, separatorIndex)) {
    if (arg === '--long') {
      long = true;
    } else {
      summaryArgs.push(arg);
    }
  }

  if (summaryArgs.length !== 1 || summaryArgs[0].trim() === '') {
    throw new CliUsageError(STEP_USAGE);
  }

  return {
    long,
    summary: summaryArgs[0],
    command,
  };
}

/**
 * @param {string[]} args
 * @returns {{ status: import('../runner/runnerResult.types.js').RunnerResultStatus, filePath?: string }}
 */
function parseRunnerResultArgs(args) {
  const consumed = new Set();
  const rawStatus = parseOptionalStringOption(args, '--status', consumed);
  const filePath = parseOptionalStringOption(args, '--file', consumed);

  if (rawStatus === undefined) {
    throw new CliUsageError(
      `Missing value for "--status". Expected one of: ${RUNNER_RESULT_STATUSES.join(', ')}.`,
    );
  }

  if (!isRunnerResultStatus(rawStatus)) {
    throw new CliUsageError(
      `runner-result --status must be one of: ${RUNNER_RESULT_STATUSES.join(', ')}.`,
    );
  }

  const remaining = args.filter((value, argIndex) => {
    void value;
    return !consumed.has(argIndex);
  });
  if (remaining.length > 0) {
    throw new CliUsageError(`Unknown arguments for runner-result: ${remaining.join(' ')}.`);
  }

  return {
    status: rawStatus,
    ...(filePath === undefined ? {} : { filePath }),
  };
}

/**
 * @param {import('../local-run-state/types.js').LocalRunState} state
 * @param {{
 *   force: boolean,
 *   now: Date,
 *   heartbeatIntervalMs: number,
 * }} options
 * @returns {boolean}
 */
function isStepHeartbeatDue(state, { force, now, heartbeatIntervalMs }) {
  if (force) {
    return true;
  }

  if ((state.heartbeatCount ?? 0) === 0) {
    return true;
  }

  const heartbeatAt = Date.parse(state.heartbeatAt);
  if (!Number.isFinite(heartbeatAt) || now.getTime() - heartbeatAt >= heartbeatIntervalMs) {
    return true;
  }

  return (
    (state.completedNonHeartbeatStepsSinceHeartbeat ?? 0) >=
    COMPLETED_NON_HEARTBEAT_STEPS_BEFORE_HEARTBEAT
  );
}

/**
 * @param {import('../local-run-state/types.js').LocalRunState} state
 * @returns {number}
 */
function readStepHeartbeatIntervalMs(state) {
  return state.heartbeatIntervalMs > 0
    ? state.heartbeatIntervalMs
    : DEFAULT_LOCAL_RUN_HEARTBEAT_INTERVAL_MS;
}

/**
 * @param {number | null} code
 * @param {NodeJS.Signals | null} signal
 * @returns {number}
 */
function readWrappedCommandExitCode(code, signal) {
  if (code !== null) {
    return code;
  }

  switch (signal) {
    case 'SIGHUP':
      return 129;
    case 'SIGINT':
      return 130;
    case 'SIGTERM':
      return 143;
    default:
      return 1;
  }
}

/**
 * @param {string[]} args
 * @param {string} reference
 * @returns {{ targetNumber: number, backend: 'github-actions' }}
 */
function parseGitHubActionsOperationLabelArgs(args, reference) {
  rejectGitHubActionsLocalOnlyFlag(args, '--publish');
  rejectGitHubActionsLocalOnlyFlag(args, '--until');
  rejectGitHubActionsLocalOnlyFlag(args, '--events');

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

  const runGoal = parseOperationRunGoal({
    args,
    consumed,
    defaultRunGoal: 'finalized',
  });
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
 *   runGoal: import('./types.js').OperationRunGoal,
 *   eventsFormat?: 'jsonl',
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

  const eventsFormat = parseOptionalStringOption(args, '--events', consumed);
  if (eventsFormat !== undefined) {
    if (reference !== 'prd:auto-complete') {
      throw new CliUsageError(`--events jsonl is only supported for local prd:auto-complete.`);
    }

    if (eventsFormat !== 'jsonl') {
      throw new CliUsageError(
        `Unsupported events format "${eventsFormat}". Expected "--events jsonl".`,
      );
    }
  }

  const publicationMode = parsePublicationMode(args, consumed);
  const runGoal = parseOperationRunGoal({
    args,
    consumed,
    defaultRunGoal: 'finalized',
  });
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
    runGoal,
    ...(eventsFormat === undefined ? {} : { eventsFormat }),
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
 * @param {object} options
 * @param {string[]} options.args
 * @param {Set<number>} options.consumed
 * @param {import('./types.js').OperationRunGoal} [options.defaultRunGoal]
 * @returns {import('./types.js').OperationRunGoal}
 */
function parseOperationRunGoal({ args, consumed, defaultRunGoal = 'operation' }) {
  const rawRunGoal = parseOptionalStringOption(args, '--until', consumed);
  if (rawRunGoal === undefined) {
    return defaultRunGoal;
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
 * @returns {{ filePath?: string }}
 */
function parsePublishIssueArgs(args) {
  const consumed = new Set();
  const filePath = parseOptionalStringOption(args, '--file', consumed);

  const remaining = args.filter((value, argIndex) => {
    void value;
    return !consumed.has(argIndex);
  });

  if (remaining.length > 0) {
    throw new CliUsageError(`Unknown arguments for issues publish-issue: ${remaining.join(' ')}.`);
  }

  return filePath === undefined ? {} : { filePath };
}

/**
 * @param {string[]} args
 * @returns {{ filePath?: string, parentIssueNumber?: number, forceUpdate: boolean }}
 */
function parsePublishChildrenArgs(args) {
  const consumed = new Set();
  const filePath = parseOptionalStringOption(args, '--file', consumed);
  const rawParentIssueNumber = parseOptionalStringOption(args, '--parent', consumed);
  const forceUpdate = parseBooleanFlag(args, '--force', consumed);

  const remaining = args.filter((value, argIndex) => {
    void value;
    return !consumed.has(argIndex);
  });

  if (remaining.length > 0) {
    throw new CliUsageError(
      `Unknown arguments for issues publish-children: ${remaining.join(' ')}.`,
    );
  }

  const parentIssueNumber =
    rawParentIssueNumber === undefined
      ? undefined
      : parsePositiveInteger(rawParentIssueNumber, '--parent');

  return {
    ...(filePath === undefined ? {} : { filePath }),
    ...(parentIssueNumber === undefined ? {} : { parentIssueNumber }),
    forceUpdate,
  };
}

/**
 * @param {string[]} args
 * @returns {{ filePath?: string }}
 */
function parsePublishPrdArgs(args) {
  const consumed = new Set();
  const filePath = parseOptionalStringOption(args, '--file', consumed);

  const remaining = args.filter((value, argIndex) => {
    void value;
    return !consumed.has(argIndex);
  });

  if (remaining.length > 0) {
    throw new CliUsageError(`Unknown arguments for issues publish-prd: ${remaining.join(' ')}.`);
  }

  return filePath === undefined ? {} : { filePath };
}

/**
 * @param {{
 *   cwd: string,
 *   filePath?: string,
 *   stdin: NodeJS.ReadableStream,
 * }} options
 * @returns {Promise<string>}
 */
async function readPublishIssueInput({ cwd, filePath, stdin }) {
  if (filePath !== undefined) {
    return await readFile(resolvePublishInputPath({ cwd, filePath }), 'utf8');
  }

  let rawRequest = '';
  for await (const chunk of stdin) {
    rawRequest += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  }

  return rawRequest;
}

/**
 * @param {{
 *   cwd: string,
 *   filePath?: string,
 *   stdin: NodeJS.ReadableStream,
 * }} options
 * @returns {Promise<string>}
 */
async function readPublishChildrenInput({ cwd, filePath, stdin }) {
  if (filePath !== undefined) {
    return await readFile(resolvePublishInputPath({ cwd, filePath }), 'utf8');
  }

  let rawRequest = '';
  for await (const chunk of stdin) {
    rawRequest += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  }

  return rawRequest;
}

/**
 * @param {{
 *   cwd: string,
 *   filePath?: string,
 *   stdin: NodeJS.ReadableStream,
 * }} options
 * @returns {Promise<string>}
 */
async function readPublishPrdInput({ cwd, filePath, stdin }) {
  if (filePath !== undefined) {
    return await readFile(resolvePublishInputPath({ cwd, filePath }), 'utf8');
  }

  let rawRequest = '';
  for await (const chunk of stdin) {
    rawRequest += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  }

  return rawRequest;
}

/**
 * @param {{ cwd: string, filePath: string }} options
 * @returns {string}
 */
function resolvePublishInputPath({ cwd, filePath }) {
  return isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
}

/**
 * @param {string[]} args
 * @param {'--publish' | '--until' | '--events'} flag
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
 * @param {string} rawValue
 * @param {string} optionName
 * @returns {number}
 */
function parsePositiveInteger(rawValue, optionName) {
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

  if (rawPhase === 'run' || rawPhase === 'prepare' || rawPhase === 'complete') {
    return rawPhase;
  }

  throw new CliUsageError(`Unknown phase "${rawPhase}". Expected one of: run, prepare, complete.`);
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
 * @param {string[]} args
 * @param {string} optionName
 * @param {Set<number>} consumed
 * @returns {boolean}
 */
function parseBooleanFlag(args, optionName, consumed) {
  const index = args.indexOf(optionName);
  if (index === -1) {
    return false;
  }

  consumed.add(index);
  return true;
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {import('./types.js').OperationContextUsage | undefined}
 */
function readContextUsage(env) {
  const used = readPositiveIntegerEnv(env.PULLOPS_CONTEXT_USED_TOKENS);
  const limit = readPositiveIntegerEnv(env.PULLOPS_CONTEXT_LIMIT_TOKENS);

  if (used === undefined) {
    return undefined;
  }

  return limit === undefined ? { used } : { used, limit };
}

/**
 * @param {unknown} output
 * @returns {0 | 1}
 */
function readOperationExitCode(output) {
  if (typeof output === 'string') {
    try {
      output = JSON.parse(output);
    } catch {
      return 0;
    }
  }

  return isRecord(output) && (output.status === 'refused' || output.status === 'failed') ? 1 : 0;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
 */
function validateRunnerLifecycle({ operationName, phase, runnerAdapter }) {
  const supportedRunnerLifecycles = getOperationCatalogSupportedRunnerLifecycles(operationName);
  if (supportedRunnerLifecycles !== undefined) {
    const supportedRunnerAdapters = getOperationCatalogSupportedRunnerAdapters(operationName);
    const supportedRunnerPhases = getOperationCatalogSupportedRunnerPhases(operationName);
    if (supportedRunnerAdapters === undefined || supportedRunnerPhases === undefined) {
      throw new Error(
        `${operationName} runner lifecycle facts are missing from the operation catalog.`,
      );
    }

    const supportedPhasesForRunnerAdapter = supportedRunnerLifecycles
      .filter(([supportedRunnerAdapter]) => supportedRunnerAdapter === runnerAdapter)
      .map(([, supportedPhase]) => supportedPhase);
    const supportsLifecycle = supportedRunnerLifecycles.some(
      ([supportedRunnerAdapter, supportedPhase]) =>
        supportedRunnerAdapter === runnerAdapter && supportedPhase === phase,
    );

    if (!supportsLifecycle) {
      if (runnerAdapter === 'external') {
        if (supportedPhasesForRunnerAdapter.length > 0) {
          throw new CliUsageError(
            `${operationName} with --runner external requires ${formatPhaseRequirement(
              supportedPhasesForRunnerAdapter,
            )}.`,
          );
        }

        throw new CliUsageError(
          `${operationName} only supports ${supportedRunnerAdapters.join(
            ', ',
          )} with the ${supportedRunnerPhases.join(', ')} phase.`,
        );
      }

      throw new CliUsageError(
        `${operationName} with --runner ${runnerAdapter} only supports the default run phase.`,
      );
    }

    if (runnerAdapter === 'external') {
      return;
    }

    if (phase !== 'run') {
      throw new CliUsageError(
        `${operationName} with --runner ${runnerAdapter} only supports the default run phase.`,
      );
    }

    return;
  }

  if (runnerAdapter === 'external') {
    if (phase === 'run') {
      throw new CliUsageError(
        `${operationName} with --runner external requires "--phase prepare" or "--phase complete".`,
      );
    }

    return;
  }

  if (phase !== 'run') {
    throw new CliUsageError(
      `${operationName} with --runner ${runnerAdapter} only supports the default run phase.`,
    );
  }
}

/**
 * @param {readonly import('../cli/types.js').OperationPhase[]} phases
 * @returns {string}
 */
function formatPhaseRequirement(phases) {
  if (phases.length === 1) {
    return `"--phase ${phases[0]}"`;
  }

  if (phases.length === 2) {
    return `"--phase ${phases[0]}" or "--phase ${phases[1]}"`;
  }

  const requiredPhases = phases.map(phase => `"--phase ${phase}"`);
  return `${requiredPhases.slice(0, -1).join(', ')}, or ${requiredPhases.at(-1)}`;
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
    `Local execution is currently only supported for: ${readLocalOperationLabelReferenceNames().join(', ')}.`,
    `Use "${reference} --backend github-actions" to dispatch the canonical PullOps label through GitHub Actions.`,
  ].join(' ');
}

/**
 * @returns {string}
 */
function usage() {
  return [
    'Usage:',
    '  pullops init [--check] [--json] [--force]',
    '  pullops setup doctor [--check] [--profile full|local|authoring|github-actions] [--json] [--repo <owner/repo>]',
    '  pullops setup skills [--check] [--json] [--force]',
    '  pullops setup agent-docs [--check] [--json] [--force]',
    '  pullops setup github-actions [--check] [--json] [--force]',
    '  pullops setup github-labels [--check] [--json] [--force] [--repo <owner/repo>]',
    '  pullops run issue:implement <issue-number> [--backend local] [--publish dry-run|pr] [--until operation|finalized]',
    '  pullops run prd:auto-advance <parent-issue-number> [--backend local] [--publish dry-run|pr] [--until operation|finalized]',
    '  pullops run prd:auto-complete <parent-issue-number> [--backend local] [--events jsonl] [--publish dry-run|pr] [--until operation|finalized]',
    '  pullops run pr:review|pr:address-review|pr:fix-ci|pr:update-branch|pr:resolve-conflicts|pr:finalize <pull-request-number> [--backend local]',
    '  pullops run <operation-label-reference> <target-number> --backend github-actions',
    '  pullops run <operation> [--runner codex-cli] --issue <number>',
    '  pullops run <operation> [--runner codex-cli] --pr <number>',
    '  pullops run <operation> --runner external --phase prepare --issue <number>',
    '  pullops run <operation> --runner external --phase complete --issue <number>',
    '  pullops run <operation> --runner external --phase prepare --pr <number>',
    '  pullops run <operation> --runner external --phase complete --pr <number>',
    '  pullops issues publish-prd [--file <path>]',
    '  pullops issues publish-children [--parent <parent-issue-number>] [--file <path>] [--force]',
    '  pullops issues publish-issue [--file <path>]',
    '  pullops heartbeat [--state <path>] [--token <token>] [--summary <text>]',
    '  pullops runner-result --status success|failed|cancelled|skipped [--file <path>]',
    '  pullops step [--long] "<summary>" -- <command...>',
  ].join('\n');
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @param {string} reference
 * @returns {string}
 */
function readRequiredOperationLabelReference(reference) {
  const operation = getOperationLabelReference(reference);
  if (operation === undefined) {
    throw new Error(`Unknown operation label reference "${reference}".`);
  }

  return operation.reference;
}

/**
 * @param {unknown} error
 * @returns {string | undefined}
 */
function readLocalRunRecordFromError(error) {
  if (
    isRecord(error) &&
    typeof error.localRunRecord === 'string' &&
    error.localRunRecord.trim() !== ''
  ) {
    return error.localRunRecord.trim();
  }

  const match = getErrorMessage(error).match(/Local Run Record:\s*(.+)$/);
  return match === null ? undefined : match[1].trim();
}

/**
 * @param {unknown} error
 * @param {{ localRunRecord: string }} options
 * @returns {Record<string, unknown> | undefined}
 */
function readKnownLocalPrdRunBoundaryOutput(error, { localRunRecord }) {
  if (!isRecord(error) || !isRecord(error.localPrdRunBoundary)) {
    return undefined;
  }

  const boundary = /** @type {Record<string, unknown>} */ (error.localPrdRunBoundary);
  /** @type {Record<string, unknown>} */
  const output = {
    ...boundary,
    localRunRecord,
  };
  if (output.status !== 'blocked' && output.status !== 'refused') {
    return undefined;
  }

  return output;
}

/**
 * @param {{
 *   error: unknown,
 *   localRunRecord: string,
 *   targetNumber: number,
 *   publicationMode: 'dry-run' | 'publish',
 * }} options
 * @returns {Record<string, unknown>}
 */
function createLocalPrdAutoCompleteFailureOutput({
  error,
  localRunRecord,
  targetNumber,
  publicationMode,
}) {
  const failureReason = getErrorMessage(error).trim() || 'Unexpected runtime or tool failure.';
  const summary = `Local PRD auto-complete for issue #${targetNumber} failed unexpectedly.`;

  return {
    status: 'failed',
    summary,
    displayMessage: summary,
    failureReason,
    mode: 'auto-complete',
    publicationMode,
    localRunRecord,
  };
}

/**
 * @param {object} options
 * @param {string} options.cwd
 * @param {Date} options.createdAt
 * @param {string} options.rawRequest
 * @param {string} options.failureReason
 * @returns {Promise<ChildIssuePublishFailureOutput>}
 */
async function writePublishChildrenFailure({ cwd, createdAt, rawRequest, failureReason }) {
  const runRecord = createIssueStoreRunRecordLocation({
    cwd,
    operationReference: 'issues:publish-children',
    targetReference: 'invalid',
    createdAt,
  });

  await writeIssueStoreRunArtifact(runRecord, 'request.raw.txt', `${rawRequest}\n`);

  /** @type {ChildIssuePublishFailureOutput} */
  const output = {
    status: 'failed',
    summary: 'Publish Child Issue batch failed.',
    failureReason,
    warnings: [],
    localRunRecord: runRecord.directory,
  };
  await writeIssueStoreRunArtifact(
    runRecord,
    'response.json',
    `${JSON.stringify(output, null, 2)}\n`,
  );
  await writeIssueStoreRunArtifact(runRecord, 'failure-reason.txt', `${failureReason}\n`);
  return output;
}

/**
 * @param {object} options
 * @param {string} options.cwd
 * @param {Date} options.createdAt
 * @param {string} options.rawRequest
 * @param {string} options.failureReason
 * @returns {Promise<ConcreteIssuePublishFailureOutput>}
 */
async function writePublishIssueFailure({ cwd, createdAt, rawRequest, failureReason }) {
  const runRecord = createIssueStoreRunRecordLocation({
    cwd,
    operationReference: 'issues:publish-issue',
    targetReference: 'invalid',
    createdAt,
  });

  await writeIssueStoreRunArtifact(runRecord, 'request.raw.txt', `${rawRequest}\n`);

  /** @type {ConcreteIssuePublishFailureOutput} */
  const output = {
    status: 'failed',
    summary: 'Publish issue request failed.',
    failureReason,
    warnings: [],
    localRunRecord: runRecord.directory,
  };
  await writeIssueStoreRunArtifact(
    runRecord,
    'response.json',
    `${JSON.stringify(output, null, 2)}\n`,
  );
  await writeIssueStoreRunArtifact(runRecord, 'failure-reason.txt', `${failureReason}\n`);
  return output;
}

/**
 * @param {object} options
 * @param {string} options.cwd
 * @param {Date} options.createdAt
 * @param {string} options.rawRequest
 * @param {string} options.failureReason
 * @returns {Promise<PrdIssuePublishFailureOutput>}
 */
async function writePublishPrdFailure({ cwd, createdAt, rawRequest, failureReason }) {
  const runRecord = createIssueStoreRunRecordLocation({
    cwd,
    operationReference: 'issues:publish-prd',
    targetReference: 'invalid',
    createdAt,
  });

  await writeIssueStoreRunArtifact(runRecord, 'request.raw.txt', `${rawRequest}\n`);

  /** @type {PrdIssuePublishFailureOutput} */
  const output = {
    status: 'failed',
    summary: 'Publish PRD request failed.',
    failureReason,
    warnings: [],
    localRunRecord: runRecord.directory,
  };
  await writeIssueStoreRunArtifact(
    runRecord,
    'response.json',
    `${JSON.stringify(output, null, 2)}\n`,
  );
  await writeIssueStoreRunArtifact(runRecord, 'failure-reason.txt', `${failureReason}\n`);
  return output;
}

class CliUsageError extends Error {}
