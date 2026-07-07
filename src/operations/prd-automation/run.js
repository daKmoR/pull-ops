import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  coordinatePrdAutomation,
  coordinateLocalPrdAutoAdvance,
  coordinateLocalPrdAutoComplete,
  resumePrdAutomationForParentIssue as resumePrdAutomation,
} from '../../prd-automation/childCoordination.js';
import { createRunRecordLocation } from '../../local-run-record/localRunRecord.js';
import {
  DEFAULT_LOCAL_RUN_HEARTBEAT_INTERVAL_MS,
  DEFAULT_LOCAL_RUN_LEASE_DURATION_MS,
  LOCAL_RUN_HEARTBEAT_COMMAND,
} from '../../run-supervision/runSupervision.js';
import {
  initializeLocalRunState,
  mapLocalRunResultStatusToTerminalStatus,
  recordLocalRunWaitingForRunner,
  recordLocalRunTerminalStatus,
} from '../../local-run-state/localRunState.js';
import {
  runIssueImplement,
  runIssueImplementExternalRunnerPrepare,
} from '../issue-implement/run.js';
import {
  executeExternalRunnerHandoff,
  isExternalRunnerWaitingOutput,
} from '../../runner/externalRunnerHandoff.js';

/**
 * @typedef {import('../../cli/types.js').OperationRunnerContext} OperationRunnerContext
 * @typedef {import('../../local-run-state/types.js').LocalRunRunLink} LocalRunRunLink
 * @typedef {'pr-review' | 'pr-address-review' | 'pr-fix-ci' | 'pr-resolve-conflicts' | 'pr-finalize'} PullRequestOperationName
 */

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
export async function runPrdAutoAdvance(context) {
  assertIssueTarget(context, 'prd-auto-advance');
  if (context.executionBackend === 'local') {
    const localContext = withDefaultLocalPrdRunGoal(context);
    return await coordinateLocalPrdAutoAdvance(localContext, {
      parentIssueNumber: localContext.target.number,
      async runChildIssue(childIssueNumber, options = {}) {
        if (shouldRunNestedExternalHandoffs(localContext)) {
          return await runLocalPublishedExternalIssueOperation(localContext, {
            childIssueNumber,
            options,
          });
        }

        const suppressNestedOutput = shouldSuppressNestedOperationOutput(localContext);
        return await runIssueImplement({
          ...localContext,
          operation: 'issue-implement',
          target: {
            type: 'issue',
            number: childIssueNumber,
          },
          publicationMode: localContext.publicationMode,
          localRunRecordDirectory: options.localRunRecordDirectory,
          ...(options.parentRun === undefined ? {} : { parentRun: options.parentRun }),
          ...(options.parentEventSinkEnvironment === undefined
            ? {}
            : { parentEventSinkEnvironment: options.parentEventSinkEnvironment }),
          progress: suppressNestedOutput ? options.progress : localContext.progress,
          progressEventWriter: undefined,
          suppressRunnerOutput: suppressNestedOutput,
          virtualCompletedIssueNumbers: options.virtualCompletedIssueNumbers,
        });
      },
    });
  }

  return await coordinatePrdAutomation(context, {
    parentIssueNumber: context.target.number,
    mode: 'auto-advance',
  });
}

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
export async function runPrdAutoComplete(context) {
  assertIssueTarget(context, 'prd-auto-complete');
  if (context.executionBackend === 'local') {
    const localContext = withDefaultLocalPrdRunGoal(context);
    return await coordinateLocalPrdAutoComplete(localContext, {
      parentIssueNumber: localContext.target.number,
      async runChildIssue(childIssueNumber, options = {}) {
        if (shouldRunNestedExternalHandoffs(localContext)) {
          return await runLocalPublishedExternalIssueOperation(localContext, {
            childIssueNumber,
            options,
          });
        }

        const suppressNestedOutput = shouldSuppressNestedOperationOutput(localContext);
        return await runIssueImplement({
          ...localContext,
          operation: 'issue-implement',
          target: {
            type: 'issue',
            number: childIssueNumber,
          },
          publicationMode: localContext.publicationMode,
          localRunRecordDirectory: options.localRunRecordDirectory,
          ...(options.parentRun === undefined ? {} : { parentRun: options.parentRun }),
          ...(options.parentEventSinkEnvironment === undefined
            ? {}
            : { parentEventSinkEnvironment: options.parentEventSinkEnvironment }),
          progress: suppressNestedOutput ? options.progress : localContext.progress,
          progressEventWriter: undefined,
          suppressRunnerOutput: suppressNestedOutput,
          virtualCompletedIssueNumbers: options.virtualCompletedIssueNumbers,
        });
      },
      async runParentPullRequestOperation({ pullRequestNumber, operation, parentRun }) {
        return await runLocalPublishedPullRequestOperation(localContext, {
          pullRequestNumber,
          operation,
          ...(parentRun === undefined ? {} : { parentRun }),
        });
      },
      async runChildPullRequestOperation({ pullRequestNumber, operation, parentRun }) {
        return await runLocalPublishedPullRequestOperation(localContext, {
          pullRequestNumber,
          operation,
          resumeParentPrdAutomationAfterPrFinalize: false,
          ...(parentRun === undefined ? {} : { parentRun }),
        });
      },
    });
  }

  return await coordinatePrdAutomation(context, {
    parentIssueNumber: context.target.number,
    mode: 'auto-complete',
  });
}

/**
 * @param {OperationRunnerContext} context
 * @returns {boolean}
 */
function shouldRunNestedExternalHandoffs(context) {
  return (
    context.publicationMode === 'publish' &&
    (context.runnerAdapter === 'external' || context.externalRunnerJobRunner !== undefined)
  );
}

/**
 * @param {OperationRunnerContext} context
 * @param {{
 *   childIssueNumber: number,
 *   options: import('../../prd-automation/childCoordination.types.js').ChildIssueRunOptions,
 * }} request
 * @returns {Promise<Record<string, unknown>>}
 */
async function runLocalPublishedExternalIssueOperation(context, { childIssueNumber, options }) {
  const localRunRecordDirectory = requireLocalRunRecordDirectory(options.localRunRecordDirectory);
  const stateRecord = await initializeLocalRunState({
    runRecordDirectory: localRunRecordDirectory,
    operationReference: 'issue:implement',
    target: {
      type: 'issue',
      number: childIssueNumber,
    },
    publicationMode: context.publicationMode ?? 'publish',
    runGoal: 'operation',
    ...(options.parentRun === undefined ? {} : { parentRun: options.parentRun }),
  });
  const operationContext = /** @type {OperationRunnerContext} */ ({
    ...context,
    operation: 'issue-implement',
    phase: 'prepare',
    runnerAdapter: 'external',
    executionBackend: 'local',
    suppressFollowUpOperationLabels: true,
    publicationMode: context.publicationMode,
    runGoal: 'operation',
    target: {
      type: 'issue',
      number: childIssueNumber,
    },
    outputDirectory: localRunRecordDirectory,
    localRunRecordDirectory,
    ...(options.parentRun === undefined ? {} : { parentRun: options.parentRun }),
    ...(options.parentEventSinkEnvironment === undefined
      ? {}
      : { parentEventSinkEnvironment: options.parentEventSinkEnvironment }),
  });
  const output = addLocalRunRecordToNestedOutput(
    await runIssueImplementExternalRunnerPrepare(operationContext),
    stateRecord,
  );

  if (!isExternalRunnerWaitingOutput(output)) {
    await recordNestedOperationTerminalStatus(stateRecord.statePath, output, 'prepare');
    return output;
  }

  await recordLocalRunWaitingForRunner({
    statePath: stateRecord.statePath,
    summary: output.summary,
    phase: 'prepare',
    runnerJob: output.runnerJob,
  });
  if (context.externalRunnerJobRunner === undefined) {
    return output;
  }

  const completed = await executeExternalRunnerHandoff({
    runnerJob: output.runnerJob,
    runWorker: requireExternalRunnerJobRunner(context),
    ...(context.externalRunnerCommandRunner === undefined
      ? {}
      : { runCommand: context.externalRunnerCommandRunner }),
    cwd: context.cwd,
  });

  const completedWithRunRecord = addLocalRunRecordToNestedOutput(completed, stateRecord);
  await recordNestedOperationTerminalStatus(
    stateRecord.statePath,
    completedWithRunRecord,
    'complete',
  );
  return completedWithRunRecord;
}

/**
 * Resume whichever PRD automation mode is active on a Parent Issue.
 *
 * @param {OperationRunnerContext} context
 * @param {number} parentIssueNumber
 * @returns {Promise<Record<string, unknown>>}
 */
export async function resumePrdAutomationForParentIssue(context, parentIssueNumber) {
  return await resumePrdAutomation(context, parentIssueNumber);
}

/**
 * @param {OperationRunnerContext} context
 * @param {string} operationName
 * @returns {asserts context is OperationRunnerContext & { target: { type: 'issue', number: number } }}
 */
function assertIssueTarget(context, operationName) {
  if (context.target.type !== 'issue') {
    throw new Error(`${operationName} requires an issue target.`);
  }
}

/**
 * Local PRD runs should prepare the same finalized child PR branch that publication will push,
 * while callers can still request operation-only behavior explicitly.
 *
 * @param {OperationRunnerContext} context
 * @returns {OperationRunnerContext}
 */
function withDefaultLocalPrdRunGoal(context) {
  const publicationMode = context.publicationMode ?? 'dry-run';
  return {
    ...context,
    publicationMode,
    runGoal: context.runGoal ?? 'finalized',
  };
}

/**
 * @param {OperationRunnerContext} context
 * @param {{
 *   pullRequestNumber: number,
 *   operation: PullRequestOperationName,
 *   resumeParentPrdAutomationAfterPrFinalize?: boolean,
 *   parentRun?: LocalRunRunLink,
 * }} options
 * @returns {Promise<Record<string, unknown>>}
 */
async function runLocalPublishedPullRequestOperation(
  context,
  { pullRequestNumber, operation, resumeParentPrdAutomationAfterPrFinalize, parentRun },
) {
  const runRecord = await createNestedLocalPullRequestRunRecord(context, {
    pullRequestNumber,
    operation,
    parentRun,
  });
  const operationContext = createPullRequestOperationContext(context, {
    pullRequestNumber,
    operation,
    resumeParentPrdAutomationAfterPrFinalize,
    parentRun,
    localRunRecordDirectory: runRecord.directory,
  });

  try {
    let output;
    if (shouldRunNestedExternalHandoffs(context)) {
      output = await runLocalPublishedExternalPullRequestOperation(operationContext, operation);
    } else if (operation === 'pr-review') {
      const { runPrReview } = await import('../pr-review/run.js');
      output = await runPrReview(operationContext);
    } else if (operation === 'pr-address-review') {
      const { runPrAddressReview } = await import('../pr-address-review/run.js');
      output = await runPrAddressReview(operationContext);
    } else if (operation === 'pr-fix-ci') {
      const { runPrFixCi } = await import('../pr-fix-ci/run.js');
      output = await runPrFixCi(operationContext);
    } else if (operation === 'pr-resolve-conflicts') {
      const { runPrResolveConflicts } = await import('../pr-resolve-conflicts/run.js');
      output = await runPrResolveConflicts(operationContext);
    } else {
      const { runPrFinalize } = await import('../pr-finalize/run.js');
      output = await runPrFinalize(operationContext);
    }

    const withRunRecord = {
      ...output,
      localRunRecord: runRecord.directory,
    };
    await writeFile(
      join(runRecord.directory, 'result.json'),
      `${JSON.stringify(withRunRecord, null, 2)}\n`,
    );
    if (isExternalRunnerWaitingOutput(output)) {
      await recordLocalRunWaitingForRunner({
        statePath: runRecord.statePath,
        summary: String(output.summary),
        phase: 'prepare',
        runnerJob: output.runnerJob,
      });
      return withRunRecord;
    }

    await recordLocalRunTerminalStatus({
      statePath: runRecord.statePath,
      status: mapLocalRunResultStatusToTerminalStatus(
        /** @type {import('../../local-run-state/types.js').LocalRunResultStatus} */ (
          output.status
        ),
      ),
      summary: String(output.summary),
      phase: 'run',
    });
    return withRunRecord;
  } catch (error) {
    await writeFile(join(runRecord.directory, 'error.txt'), `${getErrorMessage(error)}\n`);
    await recordLocalRunTerminalStatus({
      statePath: runRecord.statePath,
      status: 'failed',
      summary: getErrorMessage(error),
      phase: 'run',
    });
    throw error;
  }
}

/**
 * @param {OperationRunnerContext} operationContext
 * @param {PullRequestOperationName} operation
 * @returns {Promise<Record<string, unknown>>}
 */
async function runLocalPublishedExternalPullRequestOperation(operationContext, operation) {
  const prepare = await readPullRequestOperationPrepareHandler(operation);
  const output = await prepare({
    ...operationContext,
    phase: 'prepare',
    runnerAdapter: 'external',
  });

  if (!isExternalRunnerWaitingOutput(output)) {
    return output;
  }

  await recordLocalRunWaitingForRunner({
    statePath: join(
      requireLocalRunRecordDirectory(operationContext.localRunRecordDirectory),
      'state.json',
    ),
    summary: String(output.summary),
    phase: 'prepare',
    runnerJob: output.runnerJob,
  });
  if (operationContext.externalRunnerJobRunner === undefined) {
    return output;
  }

  return await executeExternalRunnerHandoff({
    runnerJob: output.runnerJob,
    runWorker: requireExternalRunnerJobRunner(operationContext),
    ...(operationContext.externalRunnerCommandRunner === undefined
      ? {}
      : { runCommand: operationContext.externalRunnerCommandRunner }),
    cwd: operationContext.cwd,
  });
}

/**
 * @param {PullRequestOperationName} operation
 * @returns {Promise<(context: OperationRunnerContext) => Promise<Record<string, unknown>>>}
 */
async function readPullRequestOperationPrepareHandler(operation) {
  if (operation === 'pr-review') {
    const { runPrReviewExternalRunnerPrepare } = await import('../pr-review/run.js');
    return runPrReviewExternalRunnerPrepare;
  }

  if (operation === 'pr-address-review') {
    const { runPrAddressReviewExternalRunnerPrepare } = await import('../pr-address-review/run.js');
    return runPrAddressReviewExternalRunnerPrepare;
  }

  if (operation === 'pr-fix-ci') {
    const { runPrFixCiExternalRunnerPrepare } = await import('../pr-fix-ci/run.js');
    return runPrFixCiExternalRunnerPrepare;
  }

  if (operation === 'pr-resolve-conflicts') {
    const { runPrResolveConflictsExternalRunnerPrepare } =
      await import('../pr-resolve-conflicts/run.js');
    return runPrResolveConflictsExternalRunnerPrepare;
  }

  const { runPrFinalizeExternalRunnerPrepare } = await import('../pr-finalize/run.js');
  return runPrFinalizeExternalRunnerPrepare;
}

/**
 * @param {OperationRunnerContext} context
 * @param {{
 *   pullRequestNumber: number,
 *   operation: PullRequestOperationName,
 *   resumeParentPrdAutomationAfterPrFinalize?: boolean,
 *   parentRun?: LocalRunRunLink,
 *   localRunRecordDirectory?: string,
 * }} options
 * @returns {OperationRunnerContext}
 */
function createPullRequestOperationContext(
  context,
  {
    pullRequestNumber,
    operation,
    resumeParentPrdAutomationAfterPrFinalize,
    parentRun,
    localRunRecordDirectory,
  },
) {
  const configKey = readPullRequestOperationConfigKey(operation);
  const modelTier = context.config.operations[configKey].modelTier;
  const suppressNestedOutput = shouldSuppressNestedOperationOutput(context);
  return {
    ...context,
    operation,
    target: {
      type: 'pr',
      number: pullRequestNumber,
    },
    modelTier,
    model: context.config.runner.models[modelTier],
    localRunRecordDirectory,
    outputDirectory: localRunRecordDirectory,
    ...(parentRun === undefined ? {} : { parentRun }),
    progress: suppressNestedOutput ? undefined : context.progress,
    progressEventWriter: undefined,
    suppressRunnerOutput: suppressNestedOutput,
    ...(operation === 'pr-finalize' ? { allowAbsentReviewedHeadChecks: true } : {}),
    suppressFollowUpOperationLabels: true,
    ...(resumeParentPrdAutomationAfterPrFinalize === undefined
      ? {}
      : { resumeParentPrdAutomationAfterPrFinalize }),
  };
}

/**
 * @param {string | undefined} localRunRecordDirectory
 * @returns {string}
 */
function requireLocalRunRecordDirectory(localRunRecordDirectory) {
  if (localRunRecordDirectory === undefined || localRunRecordDirectory.trim() === '') {
    throw new Error('Nested external PullOps operations require a Local Run Record directory.');
  }

  return localRunRecordDirectory;
}

/**
 * @param {OperationRunnerContext} context
 * @returns {import('../../runner/types.js').ExternalRunnerJobRunner}
 */
function requireExternalRunnerJobRunner(context) {
  if (context.externalRunnerJobRunner === undefined) {
    throw new Error('Nested external PullOps operations require an external runner job runner.');
  }

  return context.externalRunnerJobRunner;
}

/**
 * @param {Record<string, unknown>} output
 * @param {import('../../local-run-state/types.js').LocalRunStateRecord} stateRecord
 * @returns {Record<string, unknown> & { status: string, summary: string }}
 */
function addLocalRunRecordToNestedOutput(output, stateRecord) {
  return {
    ...output,
    localRunRecord: stateRecord.runLink.statePath.replace(/\/state\.json$/, ''),
    runStatePath: stateRecord.statePath,
    status: String(output.status),
    summary: String(output.summary),
  };
}

/**
 * @param {string} statePath
 * @param {Record<string, unknown> & { status: string, summary: string }} output
 * @param {string} phase
 * @returns {Promise<void>}
 */
async function recordNestedOperationTerminalStatus(statePath, output, phase) {
  await recordLocalRunTerminalStatus({
    statePath,
    status: mapLocalRunResultStatusToTerminalStatus(
      /** @type {import('../../local-run-state/types.js').LocalRunResultStatus} */ (output.status),
    ),
    summary: output.summary,
    phase,
  });
}

/**
 * @param {OperationRunnerContext} context
 * @returns {boolean}
 */
function shouldSuppressNestedOperationOutput(context) {
  return context.suppressRunnerOutput === true || context.progressEventWriter !== undefined;
}

/**
 * @param {OperationRunnerContext} context
 * @param {{
 *   pullRequestNumber: number,
 *   operation: PullRequestOperationName,
 *   parentRun?: LocalRunRunLink,
 * }} options
 * @returns {Promise<{ directory: string, statePath: string }>}
 */
async function createNestedLocalPullRequestRunRecord(
  context,
  { pullRequestNumber, operation, parentRun },
) {
  const operationReference = readPullRequestOperationReference(operation);
  const createdAt = new Date();
  const directory = createRunRecordLocation({
    cwd: context.cwd,
    operationReference,
    targetReference: pullRequestNumber,
    createdAt,
  }).directory;

  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, 'metadata.json'),
    `${JSON.stringify(
      {
        operationReference,
        target: {
          type: 'pr',
          number: pullRequestNumber,
        },
        publicationMode: context.publicationMode ?? 'dry-run',
        runGoal: context.runGoal ?? 'operation',
        createdAt: createdAt.toISOString(),
        heartbeatCommand: LOCAL_RUN_HEARTBEAT_COMMAND,
        heartbeatIntervalMs: DEFAULT_LOCAL_RUN_HEARTBEAT_INTERVAL_MS,
        leaseDurationMs: DEFAULT_LOCAL_RUN_LEASE_DURATION_MS,
      },
      null,
      2,
    )}\n`,
  );
  const stateRecord = await initializeLocalRunState({
    runRecordDirectory: directory,
    operationReference,
    target: {
      type: 'pr',
      number: pullRequestNumber,
    },
    publicationMode: context.publicationMode ?? 'dry-run',
    runGoal: context.runGoal ?? 'operation',
    createdAt,
    ...(parentRun === undefined ? {} : { parentRun }),
  });

  return {
    directory,
    statePath: stateRecord.statePath,
  };
}

/**
 * @param {PullRequestOperationName} operation
 * @returns {'pr:review' | 'pr:address-review' | 'pr:fix-ci' | 'pr:resolve-conflicts' | 'pr:finalize'}
 */
function readPullRequestOperationReference(operation) {
  if (operation === 'pr-review') {
    return 'pr:review';
  }

  if (operation === 'pr-address-review') {
    return 'pr:address-review';
  }

  if (operation === 'pr-fix-ci') {
    return 'pr:fix-ci';
  }

  if (operation === 'pr-resolve-conflicts') {
    return 'pr:resolve-conflicts';
  }

  return 'pr:finalize';
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @param {PullRequestOperationName} operation
 * @returns {'prReview' | 'prAddressReview' | 'prFixCi' | 'prResolveConflicts' | 'prFinalize'}
 */
function readPullRequestOperationConfigKey(operation) {
  if (operation === 'pr-review') {
    return 'prReview';
  }

  if (operation === 'pr-address-review') {
    return 'prAddressReview';
  }

  if (operation === 'pr-fix-ci') {
    return 'prFixCi';
  }

  if (operation === 'pr-resolve-conflicts') {
    return 'prResolveConflicts';
  }

  return 'prFinalize';
}
