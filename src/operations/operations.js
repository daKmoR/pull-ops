import {
  runPrAddressReview,
  runPrAddressReviewCodexActionFinalize,
  runPrAddressReviewCodexActionPrepare,
} from './pr-address-review/run.js';
import { runPrCloseChildIssue } from './pr-close-child-issue/run.js';
import { runPrdCoordinate } from './prd-coordinate/run.js';
import {
  runPrFixCi,
  runPrFixCiCodexActionFinalize,
  runPrFixCiCodexActionPrepare,
} from './pr-fix-ci/run.js';
import {
  runIssueImplement,
  runIssueImplementCodexActionFinalize,
  runIssueImplementCodexActionPrepare,
} from './issue-implement/run.js';
import { runPrdPrepare } from './prd-prepare/run.js';
import {
  runPrPrepareMerge,
  runPrPrepareMergeCodexActionFinalize,
  runPrPrepareMergeCodexActionPrepare,
} from './pr-prepare-merge/run.js';
import {
  runPrReview,
  runPrReviewCodexActionFinalize,
  runPrReviewCodexActionPrepare,
} from './pr-review/run.js';

/**
 * @typedef {import('./types.js').WorkflowOperation} WorkflowOperation
 * @typedef {import('../cli/types.js').OperationRunnerContext} OperationRunnerContext
 */

/** @type {WorkflowOperation[]} */
export const WORKFLOW_OPERATIONS = [
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
    name: 'prd-coordinate',
    target: 'issue',
    option: 'issue',
    configKey: 'prdCoordinate',
  },
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
  {
    name: 'pr-prepare-merge',
    target: 'pr',
    option: 'pr',
    configKey: 'prPrepareMerge',
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

  if (context.operation === 'prd-coordinate') {
    return await runPrdCoordinate(context);
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

  if (context.operation === 'pr-prepare-merge') {
    return await runCodexBackedOperation(context, {
      run: runPrPrepareMerge,
      prepare: runPrPrepareMergeCodexActionPrepare,
      finalize: runPrPrepareMergeCodexActionFinalize,
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
