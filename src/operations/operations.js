import {
  runPrAddressReviewCodexActionFinalize,
  runPrAddressReviewCodexActionPrepare,
  runPrAddressReview,
} from './pr-address-review/run.js';
import { runPrCloseChildIssue } from './pr-close-child-issue/run.js';
import {
  runPrFixCi,
  runPrFixCiCodexActionFinalize,
  runPrFixCiCodexActionPrepare,
} from './pr-fix-ci/run.js';
import {
  runPrResolveConflicts,
  runPrResolveConflictsCodexActionFinalize,
  runPrResolveConflictsCodexActionPrepare,
} from './pr-resolve-conflicts/run.js';
import { runPrUpdateBranch } from './pr-update-branch/run.js';
import {
  runPrFinalize,
  runPrFinalizeCodexActionFinalize,
  runPrFinalizeCodexActionPrepare,
} from './pr-finalize/run.js';
import {
  runPrReview,
  runPrReviewCodexActionFinalize,
  runPrReviewCodexActionPrepare,
} from './pr-review/run.js';
import { PULL_OPS_OPERATION_LABELS } from '../labels/pullOpsLabels.js';
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

const PRD_PREPARE_WORKFLOW_OPERATION_CATALOG = getOperationCatalogWorkflowOperation('prd-prepare');
if (PRD_PREPARE_WORKFLOW_OPERATION_CATALOG === undefined) {
  throw new Error('prd-prepare workflow operation is missing from the operation catalog.');
}
/** @type {WorkflowOperation} */
const PRD_PREPARE_WORKFLOW_OPERATION = PRD_PREPARE_WORKFLOW_OPERATION_CATALOG;

const PRD_AUTO_ADVANCE_WORKFLOW_OPERATION_CATALOG =
  getOperationCatalogWorkflowOperation('prd-auto-advance');
if (PRD_AUTO_ADVANCE_WORKFLOW_OPERATION_CATALOG === undefined) {
  throw new Error('prd-auto-advance workflow operation is missing from the operation catalog.');
}
/** @type {WorkflowOperation} */
const PRD_AUTO_ADVANCE_WORKFLOW_OPERATION = PRD_AUTO_ADVANCE_WORKFLOW_OPERATION_CATALOG;

const PRD_AUTO_COMPLETE_WORKFLOW_OPERATION_CATALOG =
  getOperationCatalogWorkflowOperation('prd-auto-complete');
if (PRD_AUTO_COMPLETE_WORKFLOW_OPERATION_CATALOG === undefined) {
  throw new Error('prd-auto-complete workflow operation is missing from the operation catalog.');
}
/** @type {WorkflowOperation} */
const PRD_AUTO_COMPLETE_WORKFLOW_OPERATION = PRD_AUTO_COMPLETE_WORKFLOW_OPERATION_CATALOG;

const ISSUE_IMPLEMENT_WORKFLOW_OPERATION_CATALOG =
  getOperationCatalogWorkflowOperation('issue-implement');
if (ISSUE_IMPLEMENT_WORKFLOW_OPERATION_CATALOG === undefined) {
  throw new Error('issue-implement workflow operation is missing from the operation catalog.');
}
/** @type {WorkflowOperation} */
const ISSUE_IMPLEMENT_WORKFLOW_OPERATION = ISSUE_IMPLEMENT_WORKFLOW_OPERATION_CATALOG;

const PRD_PREPARE_OPERATION_LABEL_REFERENCE_CATALOG =
  getOperationCatalogOperationLabelReference('prd:prepare');
if (PRD_PREPARE_OPERATION_LABEL_REFERENCE_CATALOG === undefined) {
  throw new Error('prd:prepare label reference is missing from the operation catalog.');
}
/** @type {OperationLabelReference} */
const PRD_PREPARE_OPERATION_LABEL_REFERENCE = PRD_PREPARE_OPERATION_LABEL_REFERENCE_CATALOG;

const PRD_AUTO_ADVANCE_OPERATION_LABEL_REFERENCE_CATALOG =
  getOperationCatalogOperationLabelReference('prd:auto-advance');
if (PRD_AUTO_ADVANCE_OPERATION_LABEL_REFERENCE_CATALOG === undefined) {
  throw new Error('prd:auto-advance label reference is missing from the operation catalog.');
}
/** @type {OperationLabelReference} */
const PRD_AUTO_ADVANCE_OPERATION_LABEL_REFERENCE =
  PRD_AUTO_ADVANCE_OPERATION_LABEL_REFERENCE_CATALOG;

const PRD_AUTO_COMPLETE_OPERATION_LABEL_REFERENCE_CATALOG =
  getOperationCatalogOperationLabelReference('prd:auto-complete');
if (PRD_AUTO_COMPLETE_OPERATION_LABEL_REFERENCE_CATALOG === undefined) {
  throw new Error('prd:auto-complete label reference is missing from the operation catalog.');
}
/** @type {OperationLabelReference} */
const PRD_AUTO_COMPLETE_OPERATION_LABEL_REFERENCE =
  PRD_AUTO_COMPLETE_OPERATION_LABEL_REFERENCE_CATALOG;

const ISSUE_IMPLEMENT_OPERATION_LABEL_REFERENCE_CATALOG =
  getOperationCatalogOperationLabelReference('issue:implement');
if (ISSUE_IMPLEMENT_OPERATION_LABEL_REFERENCE_CATALOG === undefined) {
  throw new Error('issue:implement label reference is missing from the operation catalog.');
}
/** @type {OperationLabelReference} */
const ISSUE_IMPLEMENT_OPERATION_LABEL_REFERENCE = ISSUE_IMPLEMENT_OPERATION_LABEL_REFERENCE_CATALOG;

/** @type {WorkflowOperation[]} */
export const WORKFLOW_OPERATIONS = [
  // Issue / PRD operations
  PRD_PREPARE_WORKFLOW_OPERATION,
  ISSUE_IMPLEMENT_WORKFLOW_OPERATION,
  PRD_AUTO_ADVANCE_WORKFLOW_OPERATION,
  PRD_AUTO_COMPLETE_WORKFLOW_OPERATION,
  // PR review loop
  {
    name: 'pr-review',
    target: 'pr',
    option: 'pr',
    configKey: 'prReview',
  },
  {
    name: 'pr-address-review',
    target: 'pr',
    option: 'pr',
    configKey: 'prAddressReview',
  },
  // PR maintenance
  {
    name: 'pr-fix-ci',
    target: 'pr',
    option: 'pr',
    configKey: 'prFixCi',
  },
  {
    name: 'pr-update-branch',
    target: 'pr',
    option: 'pr',
    configKey: 'prUpdateBranch',
  },
  {
    name: 'pr-resolve-conflicts',
    target: 'pr',
    option: 'pr',
    configKey: 'prResolveConflicts',
  },
  // PR merge / bookkeeping
  {
    name: 'pr-finalize',
    target: 'pr',
    option: 'pr',
    configKey: 'prFinalize',
  },
  {
    name: 'pr-close-child-issue',
    target: 'pr',
    option: 'pr',
    configKey: 'prCloseChildIssue',
  },
];

export const WORKFLOW_OPERATION_NAMES = WORKFLOW_OPERATIONS.map(operation => operation.name);

export const WORKFLOW_OPERATION_CONFIG_KEYS = WORKFLOW_OPERATIONS.map(
  operation => operation.configKey,
);

/** @type {OperationLabelReference[]} */
export const OPERATION_LABEL_REFERENCES = [
  PRD_PREPARE_OPERATION_LABEL_REFERENCE,
  PRD_AUTO_ADVANCE_OPERATION_LABEL_REFERENCE,
  PRD_AUTO_COMPLETE_OPERATION_LABEL_REFERENCE,
  ISSUE_IMPLEMENT_OPERATION_LABEL_REFERENCE,
  {
    reference: 'pr:review',
    workflowOperationName: 'pr-review',
    target: 'pr',
    label: PULL_OPS_OPERATION_LABELS.prReview,
  },
  {
    reference: 'pr:address-review',
    workflowOperationName: 'pr-address-review',
    target: 'pr',
    label: PULL_OPS_OPERATION_LABELS.prAddressReview,
  },
  {
    reference: 'pr:fix-ci',
    workflowOperationName: 'pr-fix-ci',
    target: 'pr',
    label: PULL_OPS_OPERATION_LABELS.prFixCi,
  },
  {
    reference: 'pr:update-branch',
    workflowOperationName: 'pr-update-branch',
    target: 'pr',
    label: PULL_OPS_OPERATION_LABELS.prUpdateBranch,
  },
  {
    reference: 'pr:resolve-conflicts',
    workflowOperationName: 'pr-resolve-conflicts',
    target: 'pr',
    label: PULL_OPS_OPERATION_LABELS.prResolveConflicts,
  },
  {
    reference: 'pr:finalize',
    workflowOperationName: 'pr-finalize',
    target: 'pr',
    label: PULL_OPS_OPERATION_LABELS.prFinalize,
  },
];

export const OPERATION_LABEL_REFERENCE_NAMES = OPERATION_LABEL_REFERENCES.map(
  operation => operation.reference,
);

export const LOCAL_OPERATION_LABEL_REFERENCE_NAMES = [
  ISSUE_IMPLEMENT_OPERATION_LABEL_REFERENCE.reference,
  ...OPERATION_LABEL_REFERENCES.filter(
    operation =>
      operation.reference !== PRD_PREPARE_OPERATION_LABEL_REFERENCE.reference &&
      operation.reference !== ISSUE_IMPLEMENT_OPERATION_LABEL_REFERENCE.reference,
  ).map(operation => operation.reference),
];

/**
 * @param {string} name
 * @returns {WorkflowOperation | undefined}
 */
export function getWorkflowOperation(name) {
  const catalogOperation = getOperationCatalogWorkflowOperation(name);
  if (catalogOperation !== undefined) {
    return catalogOperation;
  }

  return WORKFLOW_OPERATIONS.find(operation => operation.name === name);
}

/**
 * @param {string} reference
 * @returns {OperationLabelReference | undefined}
 */
export function getOperationLabelReference(reference) {
  const catalogOperation = getOperationCatalogOperationLabelReference(reference);
  if (catalogOperation !== undefined) {
    return catalogOperation;
  }

  return OPERATION_LABEL_REFERENCES.find(operation => operation.reference === reference);
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
  if (context.executionBackend === 'local' && context.target.type === 'pr') {
    return await runLocalPullRequestOperation(context);
  }

  const catalogOperation = getOperationCatalogWorkflowOperation(context.operation);
  if (catalogOperation !== undefined) {
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

    return await catalogHandler(context);
  }

  if (context.operation === 'pr-review') {
    return await runCodexBackedOperation(context, {
      run: runPrReview,
      prepare: runPrReviewCodexActionPrepare,
      finalize: runPrReviewCodexActionFinalize,
    });
  }

  if (context.operation === 'pr-address-review') {
    return await runCodexBackedOperation(context, {
      run: runPrAddressReview,
      prepare: runPrAddressReviewCodexActionPrepare,
      finalize: runPrAddressReviewCodexActionFinalize,
    });
  }

  if (context.operation === 'pr-fix-ci') {
    return await runCodexBackedOperation(context, {
      run: runPrFixCi,
      prepare: runPrFixCiCodexActionPrepare,
      finalize: runPrFixCiCodexActionFinalize,
    });
  }

  if (context.operation === 'pr-update-branch') {
    if (context.runnerAdapter === 'codex-action') {
      throw new Error('pr-update-branch does not support the codex-action runner adapter.');
    }

    return await runPrUpdateBranch(context);
  }

  if (context.operation === 'pr-resolve-conflicts') {
    return await runCodexBackedOperation(context, {
      run: runPrResolveConflicts,
      prepare: runPrResolveConflictsCodexActionPrepare,
      finalize: runPrResolveConflictsCodexActionFinalize,
    });
  }

  if (context.operation === 'pr-finalize') {
    return await runCodexBackedOperation(context, {
      run: runPrFinalize,
      prepare: runPrFinalizeCodexActionPrepare,
      finalize: runPrFinalizeCodexActionFinalize,
    });
  }

  if (context.operation === 'pr-close-child-issue') {
    return await runPrCloseChildIssue(context);
  }

  if (context.runnerAdapter === 'codex-action') {
    throw new Error(`${context.operation} does not support the codex-action runner adapter.`);
  }

  return runPlaceholderOperation(context);
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
 * @param {OperationRunnerContext} context
 * @param {{
 *   run: (context: OperationRunnerContext) => Promise<Record<string, unknown>>;
 *   prepare: (context: OperationRunnerContext) => Promise<Record<string, unknown>>;
 *   finalize: (context: OperationRunnerContext) => Promise<Record<string, unknown>>;
 * }} handlers
 * @returns {Promise<Record<string, unknown>>}
 */
async function runCodexBackedOperation(context, handlers) {
  if (context.runnerAdapter === 'codex-cli') {
    return await handlers.run(context);
  }

  if (context.phase === 'prepare') {
    return await handlers.prepare(context);
  }

  if (context.phase === 'finalize') {
    return await handlers.finalize(context);
  }

  throw new Error(`${context.operation} has unsupported runner lifecycle arguments.`);
}

/**
 * @param {OperationRunnerContext} context
 * @returns {Record<string, unknown>}
 */
function runPlaceholderOperation({ operation, target, modelTier, model }) {
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
 * @param {unknown} error
 * @returns {string}
 */
function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
