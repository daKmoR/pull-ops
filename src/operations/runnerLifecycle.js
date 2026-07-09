import { isAbsolute, resolve } from 'node:path';

import { readLocalRunStateRecordFromDirectory } from '../local-run-state/localRunState.js';
import {
  createExternalRunnerJob,
  createSkippedExternalRunnerOutput,
  isSkippedExternalRunnerResult,
  readExternalRunnerOutput,
  writeExternalRunnerPrompt,
} from './externalRunner.js';
import { runLocalPullRequestOperation } from './runLocalPullRequestOperation.js';

/**
 * @typedef {import('../cli/types.js').OperationPhase} OperationPhase
 * @typedef {import('../cli/types.js').OperationRunnerContext} OperationRunnerContext
 * @typedef {import('./runnerLifecycle.types.js').FinalizeOperationRunnerStepOptions} FinalizeOperationRunnerStepOptions
 * @typedef {import('./runnerLifecycle.types.js').OperationDescriptor} OperationDescriptor
 * @typedef {import('./runnerLifecycle.types.js').RunnerLifecycleOperationFactory} RunnerLifecycleOperationFactory
 * @typedef {import('./runnerLifecycle.types.js').RunnerStepLifecycleOperation} RunnerStepLifecycleOperation
 */

/**
 * Execute one phase of an Operation Module through its Operation Descriptor.
 *
 * The Runner Lifecycle owns the shared flow — the local dry-run guard, phase
 * dispatch, and finalize ordering — so an Operation Module describes its one
 * runner step instead of re-implementing entry scaffolding.
 *
 * @param {OperationDescriptor} descriptor
 * @param {OperationPhase} phase
 * @param {OperationRunnerContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
export async function executeOperationPhase(descriptor, phase, context) {
  if (phase === 'run') {
    if (
      context.target.type === 'pr' &&
      context.executionBackend === 'local' &&
      context.publicationMode !== 'publish'
    ) {
      return await runLocalPullRequestOperation(
        context,
        descriptor.localRun === undefined ? {} : { runPrepared: descriptor.localRun },
      );
    }

    if (descriptor.run !== undefined) {
      return await descriptor.run(context);
    }

    return await runOperationRunnerStep(context, requireCreateOperation(descriptor, phase));
  }

  if (phase === 'prepare') {
    if (descriptor.prepare !== undefined) {
      return await descriptor.prepare(context);
    }

    return await prepareOperationRunnerStep(context, requireCreateOperation(descriptor, phase));
  }

  if (phase === 'complete') {
    const output =
      descriptor.complete !== undefined
        ? await descriptor.complete(context)
        : await finalizeOperationRunnerStep(
            context,
            descriptor.createFinalizeOperation ?? requireCreateOperation(descriptor, phase),
            descriptor.finalize ?? { order: 'prepare-first' },
          );
    return await appendParentSpecContinuation(context, output);
  }

  throw new Error(
    `Unknown operation phase "${phase}" for the ${descriptor.operationReference} descriptor.`,
  );
}

const PARENT_SPEC_OPERATION_REFERENCES = new Set(['spec:auto-advance', 'spec:auto-complete']);

/**
 * Completing a ticket operation under a Spec run points the operator back at the
 * parent command, so the continuation is machine-readable output instead of
 * operator-skill prose.
 *
 * @param {OperationRunnerContext} context
 * @param {Record<string, unknown>} output
 * @returns {Promise<Record<string, unknown>>}
 */
async function appendParentSpecContinuation(context, output) {
  if (output.status !== 'accepted') {
    return output;
  }

  const state = await readCompletedRunState(context);
  const parentRun = state?.parentRun;
  if (
    state === undefined ||
    parentRun === undefined ||
    !PARENT_SPEC_OPERATION_REFERENCES.has(parentRun.operationReference)
  ) {
    return output;
  }

  const description = `Continue ${parentRun.operationReference} for parent issue #${parentRun.target.number}.`;
  return {
    ...output,
    nextSteps: [...(Array.isArray(output.nextSteps) ? output.nextSteps : []), description],
    suggestedActions: [
      ...(Array.isArray(output.suggestedActions) ? output.suggestedActions : []),
      {
        kind: 'command',
        description,
        argv: [
          'pullops',
          'run',
          parentRun.operationReference,
          String(parentRun.target.number),
          '--runner',
          'external',
          ...(parentRun.operationReference === 'spec:auto-complete' ? ['--events', 'jsonl'] : []),
          ...(state.publicationMode === 'publish' ? ['--publish', 'pr'] : []),
        ],
        approvalRequired: false,
      },
    ],
  };
}

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<import('../local-run-state/types.js').LocalRunState | undefined>}
 */
async function readCompletedRunState(context) {
  if (context.outputDirectory === undefined || context.outputDirectory.trim() === '') {
    return undefined;
  }

  const outputDirectory = isAbsolute(context.outputDirectory)
    ? context.outputDirectory
    : resolve(context.cwd, context.outputDirectory);
  try {
    return (await readLocalRunStateRecordFromDirectory(outputDirectory)).state;
  } catch (error) {
    if (/** @type {{ code?: string }} */ (error).code === 'ENOENT') {
      return undefined;
    }

    throw error;
  }
}

/**
 * @param {OperationDescriptor} descriptor
 * @param {OperationPhase} phase
 * @returns {RunnerLifecycleOperationFactory}
 */
function requireCreateOperation(descriptor, phase) {
  if (descriptor.createOperation === undefined) {
    throw new Error(
      `The ${descriptor.operationReference} descriptor is missing createOperation for the ${phase} phase.`,
    );
  }

  return descriptor.createOperation;
}

/**
 * Run an operation's runner step inline through the codex-cli Runner Adapter.
 *
 * @param {OperationRunnerContext} context
 * @param {RunnerLifecycleOperationFactory} createOperation
 * @returns {Promise<Record<string, unknown>>}
 */
export async function runOperationRunnerStep(context, createOperation) {
  const operation = await createOperation(context);
  if (operation.status === 'settled') {
    return operation.output;
  }

  let rawOutput;

  try {
    rawOutput = await context.runner.run({
      cwd: context.cwd,
      command: context.config.runner.command,
      argsTemplate: context.config.runner.argsTemplate,
      model: operation.model,
      prompt: operation.prompt,
      ...(operation.runOptions?.streamOutput === undefined
        ? {}
        : { streamOutput: operation.runOptions.streamOutput }),
      ...(operation.runOptions?.env === undefined ? {} : { env: operation.runOptions.env }),
    });
  } catch (error) {
    await operation.onRunnerFailure?.(error);
    throw error;
  }

  return await operation.finalize(rawOutput);
}

/**
 * Prepare an operation's runner step for the external Runner Adapter:
 * write the worker prompt and describe the external runner job.
 *
 * @param {OperationRunnerContext} context
 * @param {RunnerLifecycleOperationFactory} createOperation
 * @returns {Promise<Record<string, unknown>>}
 */
export async function prepareOperationRunnerStep(context, createOperation) {
  const operation = await createOperation(context);
  if (operation.status === 'settled') {
    return operation.output;
  }

  let handoff;
  try {
    handoff = await writeExternalRunnerPrompt(context, operation.prompt, {
      branch: operation.branch,
    });
  } catch (error) {
    await operation.onRunnerFailure?.(error);
    throw error;
  }

  return {
    status: 'waiting',
    summary: operation.waiting.summary,
    ...operation.waiting.details,
    runnerJob: createExternalRunnerJob(context, handoff, {
      model: operation.model,
      branch: operation.branch,
    }),
  };
}

/**
 * Finalize an operation's runner step for the external Runner Adapter:
 * read the external runner output and hand it to the operation.
 *
 * @param {OperationRunnerContext} context
 * @param {RunnerLifecycleOperationFactory} createOperation
 * @param {FinalizeOperationRunnerStepOptions} options
 * @returns {Promise<Record<string, unknown>>}
 */
export async function finalizeOperationRunnerStep(context, createOperation, options) {
  if (options.order === 'prepare-first') {
    return await finalizePreparedOperationRunnerStep(context, createOperation, options);
  }

  return await finalizeOutputFirstOperationRunnerStep(context, createOperation, options);
}

/**
 * @param {OperationRunnerContext} context
 * @param {RunnerLifecycleOperationFactory} createOperation
 * @param {FinalizeOperationRunnerStepOptions} options
 * @returns {Promise<Record<string, unknown>>}
 */
async function finalizePreparedOperationRunnerStep(context, createOperation, options) {
  const operation = await createOperation(context);
  if (operation.status === 'settled') {
    return operation.output;
  }

  let rawOutput;

  try {
    rawOutput = await readOperationRunnerOutput(context, options);
  } catch (error) {
    if (isSkippedExternalRunnerResult(error)) {
      return createSkippedExternalRunnerOutput(context);
    }

    await operation.onRunnerFailure?.(error);
    throw error;
  }

  return await operation.finalize(rawOutput);
}

/**
 * @param {OperationRunnerContext} context
 * @param {RunnerLifecycleOperationFactory} createOperation
 * @param {FinalizeOperationRunnerStepOptions} options
 * @returns {Promise<Record<string, unknown>>}
 */
async function finalizeOutputFirstOperationRunnerStep(context, createOperation, options) {
  let rawOutput;

  try {
    rawOutput = await readOperationRunnerOutput(context, options);
  } catch (error) {
    if (isSkippedExternalRunnerResult(error)) {
      return createSkippedExternalRunnerOutput(context);
    }

    await options.onOutputError?.(context, error);
    throw error;
  }

  const operation = await createOperation(context);
  if (operation.status === 'settled') {
    return operation.output;
  }

  return await operation.finalize(rawOutput);
}

/**
 * @param {OperationRunnerContext} context
 * @param {FinalizeOperationRunnerStepOptions} options
 * @returns {Promise<unknown>}
 */
async function readOperationRunnerOutput(context, options) {
  return await readExternalRunnerOutput(
    context,
    options.rejectSkippedPreparedRunner === true ? { rejectSkippedPreparedRunner: true } : {},
  );
}
