import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  coordinatePrdAutomation,
  coordinateLocalPrdAutoAdvance,
  coordinateLocalPrdAutoComplete,
  resumePrdAutomationForParentIssue as resumePrdAutomation,
} from '../../prd-automation/childCoordination.js';
import { createLocalPrdRunRecordLocation } from '../../prd-automation/localRunRecord.js';
import {
  DEFAULT_LOCAL_RUN_HEARTBEAT_INTERVAL_MS,
  DEFAULT_LOCAL_RUN_LEASE_DURATION_MS,
  LOCAL_RUN_HEARTBEAT_COMMAND,
  initializeLocalRunState,
  mapLocalRunResultStatusToTerminalStatus,
  recordLocalRunTerminalStatus,
} from '../../local-run-state/localRunState.js';
import { runIssueImplement } from '../issue-implement/run.js';

/**
 * @typedef {import('../../cli/types.js').OperationRunnerContext} OperationRunnerContext
 * @typedef {import('../../local-run-state/types.js').LocalRunRunLink} LocalRunRunLink
 * @typedef {'pr-review' | 'pr-address-review' | 'pr-finalize'} PullRequestOperationName
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
    if (operation === 'pr-review') {
      const { runPrReview } = await import('../pr-review/run.js');
      output = await runPrReview(operationContext);
    } else if (operation === 'pr-address-review') {
      const { runPrAddressReview } = await import('../pr-address-review/run.js');
      output = await runPrAddressReview(operationContext);
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
  const directory = createLocalPrdRunRecordLocation({
    cwd: context.cwd,
    operationReference,
    targetNumber: pullRequestNumber,
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
 * @returns {'pr:review' | 'pr:address-review' | 'pr:finalize'}
 */
function readPullRequestOperationReference(operation) {
  if (operation === 'pr-review') {
    return 'pr:review';
  }

  if (operation === 'pr-address-review') {
    return 'pr:address-review';
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
 * @returns {'prReview' | 'prAddressReview' | 'prFinalize'}
 */
function readPullRequestOperationConfigKey(operation) {
  if (operation === 'pr-review') {
    return 'prReview';
  }

  if (operation === 'pr-address-review') {
    return 'prAddressReview';
  }

  return 'prFinalize';
}
