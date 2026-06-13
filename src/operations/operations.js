import {
  runAddressReview,
  runAddressReviewCodexActionFinalize,
  runAddressReviewCodexActionPrepare,
} from './address-review/run.js';
import { runCloseChildIssue } from './close-child-issue/run.js';
import { runCoordinatePrd } from './coordinate-prd/run.js';
import { runFixCi, runFixCiCodexActionFinalize, runFixCiCodexActionPrepare } from './fix-ci/run.js';
import {
  runImplementIssue,
  runImplementIssueCodexActionFinalize,
  runImplementIssueCodexActionPrepare,
} from './implement-issue/run.js';
import { runPreparePrd } from './prepare-prd/run.js';
import {
  runPrepareMerge,
  runPrepareMergeCodexActionFinalize,
  runPrepareMergeCodexActionPrepare,
} from './prepare-merge/run.js';
import {
  runReviewPr,
  runReviewPrCodexActionFinalize,
  runReviewPrCodexActionPrepare,
} from './review-pr/run.js';

/**
 * @typedef {import('./types.js').WorkflowOperation} WorkflowOperation
 * @typedef {import('../cli/types.js').OperationRunnerContext} OperationRunnerContext
 */

/** @type {WorkflowOperation[]} */
export const WORKFLOW_OPERATIONS = [
  {
    name: 'prepare-prd',
    target: 'issue',
    option: 'issue',
    configKey: 'preparePrd',
  },
  {
    name: 'implement-issue',
    target: 'issue',
    option: 'issue',
    configKey: 'implementIssue',
  },
  {
    name: 'coordinate-prd',
    target: 'issue',
    option: 'issue',
    configKey: 'coordinatePrd',
  },
  {
    name: 'review-pr',
    target: 'pr',
    option: 'pr',
    configKey: 'reviewPr',
  },
  {
    name: 'address-review',
    target: 'pr',
    option: 'pr',
    configKey: 'addressReview',
  },
  {
    name: 'fix-ci',
    target: 'pr',
    option: 'pr',
    configKey: 'fixCi',
  },
  {
    name: 'update-branch',
    target: 'pr',
    option: 'pr',
    configKey: 'updateBranch',
  },
  {
    name: 'resolve-conflicts',
    target: 'pr',
    option: 'pr',
    configKey: 'resolveConflicts',
  },
  {
    name: 'prepare-merge',
    target: 'pr',
    option: 'pr',
    configKey: 'prepareMerge',
  },
  {
    name: 'close-child-issue',
    target: 'pr',
    option: 'pr',
    configKey: 'closeChildIssue',
  },
];

export const WORKFLOW_OPERATION_NAMES = WORKFLOW_OPERATIONS.map(operation => operation.name);

export const WORKFLOW_OPERATION_CONFIG_KEYS = WORKFLOW_OPERATIONS.map(
  operation => operation.configKey,
);

/**
 * @param {string} name
 * @returns {WorkflowOperation | undefined}
 */
export function getWorkflowOperation(name) {
  return WORKFLOW_OPERATIONS.find(operation => operation.name === name);
}

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
export async function runWorkflowOperation(context) {
  if (context.operation === 'prepare-prd') {
    return await runPreparePrd(context);
  }

  if (context.operation === 'implement-issue') {
    return await runCodexBackedOperation(context, {
      run: runImplementIssue,
      prepare: runImplementIssueCodexActionPrepare,
      finalize: runImplementIssueCodexActionFinalize,
    });
  }

  if (context.operation === 'coordinate-prd') {
    return await runCoordinatePrd(context);
  }

  if (context.operation === 'review-pr') {
    return await runCodexBackedOperation(context, {
      run: runReviewPr,
      prepare: runReviewPrCodexActionPrepare,
      finalize: runReviewPrCodexActionFinalize,
    });
  }

  if (context.operation === 'address-review') {
    return await runCodexBackedOperation(context, {
      run: runAddressReview,
      prepare: runAddressReviewCodexActionPrepare,
      finalize: runAddressReviewCodexActionFinalize,
    });
  }

  if (context.operation === 'fix-ci') {
    return await runCodexBackedOperation(context, {
      run: runFixCi,
      prepare: runFixCiCodexActionPrepare,
      finalize: runFixCiCodexActionFinalize,
    });
  }

  if (context.operation === 'prepare-merge') {
    return await runCodexBackedOperation(context, {
      run: runPrepareMerge,
      prepare: runPrepareMergeCodexActionPrepare,
      finalize: runPrepareMergeCodexActionFinalize,
    });
  }

  if (context.operation === 'close-child-issue') {
    return await runCloseChildIssue(context);
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
