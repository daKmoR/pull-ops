import {
  createExternalRunnerJob,
  createSkippedExternalRunnerOutput,
  isSkippedExternalRunnerResult,
  readExternalRunnerOutput,
  writeExternalRunnerPrompt,
} from './externalRunner.js';

/**
 * @typedef {import('../cli/types.js').OperationRunnerContext} OperationRunnerContext
 * @typedef {import('./runnerLifecycle.types.js').FinalizeOperationRunnerStepOptions} FinalizeOperationRunnerStepOptions
 * @typedef {import('./runnerLifecycle.types.js').RunnerLifecycleOperationFactory} RunnerLifecycleOperationFactory
 * @typedef {import('./runnerLifecycle.types.js').RunnerStepLifecycleOperation} RunnerStepLifecycleOperation
 */

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
