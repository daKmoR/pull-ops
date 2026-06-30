import {
  getOperationCatalogHandler,
  getOperationCatalogOperationLabelReference,
  getOperationCatalogWorkflowOperation,
  supportsOperationCatalogRunnerLifecycle,
} from './operationCatalog.js';
import { runLocalPullRequestOperation } from './runLocalPullRequestOperation.js';

/**
 * @typedef {import('./types.js').WorkflowOperation} WorkflowOperation
 * @typedef {import('./types.js').OperationLabelReference} OperationLabelReference
 * @typedef {import('../cli/types.js').OperationRunnerContext} OperationRunnerContext
 */
/**
 * @param {string} name
 * @returns {WorkflowOperation | undefined}
 */
export function getWorkflowOperation(name) {
  return getOperationCatalogWorkflowOperation(name);
}

/**
 * @param {string} reference
 * @returns {OperationLabelReference | undefined}
 */
export function getOperationLabelReference(reference) {
  return getOperationCatalogOperationLabelReference(reference);
}

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
export async function runWorkflowOperation(context) {
  if (context.executionBackend === 'local') {
    return await runWithInitialBranchRestored(context, async () => {
      return await runWorkflowOperationWithoutBranchRestore(context);
    });
  }

  return await runWorkflowOperationWithoutBranchRestore(context);
}

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
async function runWorkflowOperationWithoutBranchRestore(context) {
  const catalogOperation = getOperationCatalogWorkflowOperation(context.operation);
  if (catalogOperation === undefined) {
    throw new Error(
      `Unknown operation "${context.operation}". Expected a cataloged PullOps Operation.`,
    );
  }

  if (
    !supportsOperationCatalogRunnerLifecycle(context.operation, {
      phase: context.phase,
      runnerAdapter: context.runnerAdapter,
    })
  ) {
    throw new Error(
      `${context.operation} with --runner ${context.runnerAdapter} and --phase ${context.phase} is not supported by the operation catalog.`,
    );
  }

  const catalogHandler = getOperationCatalogHandler(context.operation, context.phase);
  if (catalogHandler === undefined) {
    throw new Error(
      `${context.operation} catalog handler is missing for --runner ${context.runnerAdapter} and --phase ${context.phase}.`,
    );
  }

  if (context.executionBackend === 'local' && context.target.type === 'pr') {
    return await runLocalPullRequestOperation(context);
  }

  return await catalogHandler(context);
}

/**
 * @param {OperationRunnerContext} context
 * @param {() => Promise<Record<string, unknown>>} run
 * @returns {Promise<Record<string, unknown>>}
 */
async function runWithInitialBranchRestored(context, run) {
  const initialBranch = await readCurrentBranchForRestore(context);
  let output;
  let runError;

  try {
    output = await run();
  } catch (error) {
    runError = error;
  }

  const restoreError = await restoreInitialBranch(context, initialBranch);
  if (runError !== undefined) {
    if (restoreError !== undefined) {
      context.progress?.(`Could not restore the starting branch: ${getErrorMessage(restoreError)}`);
    }
    throw runError;
  }

  if (restoreError !== undefined) {
    return {
      ...output,
      localBranchRestore: {
        status: 'blocked',
        branch: initialBranch,
        reason: getErrorMessage(restoreError),
      },
    };
  }

  return output ?? {};
}

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<string | undefined>}
 */
async function readCurrentBranchForRestore(context) {
  if (context.gitClient.getCurrentBranch === undefined) {
    return undefined;
  }

  const currentBranch = await context.gitClient.getCurrentBranch();
  return currentBranch === '' ? undefined : currentBranch;
}

/**
 * @param {OperationRunnerContext} context
 * @param {string | undefined} initialBranch
 * @returns {Promise<unknown | undefined>}
 */
async function restoreInitialBranch(context, initialBranch) {
  if (initialBranch === undefined) {
    return undefined;
  }

  if (context.gitClient.getCurrentBranch === undefined) {
    return undefined;
  }

  try {
    const currentBranch = await context.gitClient.getCurrentBranch();
    if (currentBranch === initialBranch) {
      return undefined;
    }

    if (context.gitClient.checkoutBranch === undefined) {
      return new Error('Git client does not support restoring the starting branch.');
    }

    context.progress?.(`Restoring branch ${initialBranch}.`);
    await context.gitClient.checkoutBranch({ branchName: initialBranch });
    return undefined;
  } catch (error) {
    return error;
  }
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
