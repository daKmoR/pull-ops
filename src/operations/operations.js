import {
  runPrAddressReview,
  runPrAddressReviewCodexActionFinalize,
  runPrAddressReviewCodexActionPrepare,
} from './pr-address-review/run.js';
import { runPrCloseChildIssue } from './pr-close-child-issue/run.js';
import { runPrdAutoAdvance, runPrdAutoComplete } from './prd-automation/run.js';
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
  runIssueImplement,
  runIssueImplementCodexActionFinalize,
  runIssueImplementCodexActionPrepare,
} from './issue-implement/run.js';
import { runPrdPrepare } from './prd-prepare/run.js';
import { runLocalPullRequestOperation } from './runLocalPullRequestOperation.js';
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

/**
 * @typedef {import('./types.js').WorkflowOperation} WorkflowOperation
 * @typedef {import('./types.js').OperationLabelReference} OperationLabelReference
 * @typedef {import('../cli/types.js').OperationRunnerContext} OperationRunnerContext
 */

/** @type {WorkflowOperation[]} */
export const WORKFLOW_OPERATIONS = [
  // Issue / PRD operations
  {
    name: 'prd-prepare',
    target: 'issue',
    option: 'issue',
    configKey: 'prdPrepare',
  },
  {
    name: 'issue-implement',
    target: 'issue',
    option: 'issue',
    configKey: 'issueImplement',
  },
  {
    name: 'prd-auto-advance',
    target: 'issue',
    option: 'issue',
    configKey: 'prdAutoAdvance',
  },
  {
    name: 'prd-auto-complete',
    target: 'issue',
    option: 'issue',
    configKey: 'prdAutoComplete',
  },
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
  {
    reference: 'prd:prepare',
    workflowOperationName: 'prd-prepare',
    target: 'issue',
    label: PULL_OPS_OPERATION_LABELS.prdPrepare,
  },
  {
    reference: 'prd:auto-advance',
    workflowOperationName: 'prd-auto-advance',
    target: 'issue',
    label: PULL_OPS_OPERATION_LABELS.prdAutoAdvance,
  },
  {
    reference: 'prd:auto-complete',
    workflowOperationName: 'prd-auto-complete',
    target: 'issue',
    label: PULL_OPS_OPERATION_LABELS.prdAutoComplete,
  },
  {
    reference: 'issue:implement',
    workflowOperationName: 'issue-implement',
    target: 'issue',
    label: PULL_OPS_OPERATION_LABELS.issueImplement,
  },
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
  'issue:implement',
  'prd:auto-advance',
  'prd:auto-complete',
  'pr:review',
  'pr:address-review',
  'pr:fix-ci',
  'pr:update-branch',
  'pr:resolve-conflicts',
  'pr:finalize',
];

/**
 * @param {string} name
 * @returns {WorkflowOperation | undefined}
 */
export function getWorkflowOperation(name) {
  return WORKFLOW_OPERATIONS.find(operation => operation.name === name);
}

/**
 * @param {string} reference
 * @returns {OperationLabelReference | undefined}
 */
export function getOperationLabelReference(reference) {
  return OPERATION_LABEL_REFERENCES.find(operation => operation.reference === reference);
}

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
export async function runWorkflowOperation(context) {
  if (context.executionBackend === 'local' && context.target.type === 'pr') {
    return await runLocalPullRequestOperation(context);
  }

  if (context.operation === 'prd-prepare') {
    return await runPrdPrepare(context);
  }

  if (context.operation === 'issue-implement') {
    return await runCodexBackedOperation(context, {
      run: runIssueImplement,
      prepare: runIssueImplementCodexActionPrepare,
      finalize: runIssueImplementCodexActionFinalize,
    });
  }

  if (context.operation === 'prd-auto-advance') {
    return await runPrdAutoAdvance(context);
  }

  if (context.operation === 'prd-auto-complete') {
    return await runPrdAutoComplete(context);
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
