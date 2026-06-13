import { runImplementIssue } from './implement-issue/run.js';
import { runReviewPr } from './review-pr/run.js';

/**
 * @typedef {import('./types.js').WorkflowOperation} WorkflowOperation
 * @typedef {import('../cli/types.js').OperationRunnerContext} OperationRunnerContext
 */

/** @type {WorkflowOperation[]} */
export const WORKFLOW_OPERATIONS = [
  {
    name: 'implement-issue',
    target: 'issue',
    option: 'issue',
    configKey: 'implementIssue',
  },
  {
    name: 'implement-prd',
    target: 'issue',
    option: 'issue',
    configKey: 'implementPrd',
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
  if (context.operation === 'implement-issue') {
    return await runImplementIssue(context);
  }

  if (context.operation === 'review-pr') {
    return await runReviewPr(context);
  }

  return runPlaceholderOperation(context);
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
