import {
  coordinatePrdAutomation,
  coordinateLocalPrdAutoAdvance,
  coordinateLocalPrdAutoComplete,
  resumePrdAutomationForParentIssue as resumePrdAutomation,
} from '../../prd-automation/childCoordination.js';
import { runIssueImplement } from '../issue-implement/run.js';

/**
 * @typedef {import('../../cli/types.js').OperationRunnerContext} OperationRunnerContext
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
        return await runIssueImplement({
          ...localContext,
          operation: 'issue-implement',
          target: {
            type: 'issue',
            number: childIssueNumber,
          },
          publicationMode: localContext.publicationMode,
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
        return await runIssueImplement({
          ...localContext,
          operation: 'issue-implement',
          target: {
            type: 'issue',
            number: childIssueNumber,
          },
          publicationMode: localContext.publicationMode,
          virtualCompletedIssueNumbers: options.virtualCompletedIssueNumbers,
        });
      },
      async runParentPullRequestOperation({ pullRequestNumber, operation }) {
        return await runLocalPublishedPullRequestOperation(localContext, {
          pullRequestNumber,
          operation,
        });
      },
      async runChildPullRequestOperation({ pullRequestNumber, operation }) {
        return await runLocalPublishedPullRequestOperation(localContext, {
          pullRequestNumber,
          operation,
          resumeParentPrdAutomationAfterPrFinalize: false,
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
 * }} options
 * @returns {Promise<Record<string, unknown>>}
 */
async function runLocalPublishedPullRequestOperation(
  context,
  { pullRequestNumber, operation, resumeParentPrdAutomationAfterPrFinalize },
) {
  const operationContext = createPullRequestOperationContext(context, {
    pullRequestNumber,
    operation,
    resumeParentPrdAutomationAfterPrFinalize,
  });

  if (operation === 'pr-review') {
    const { runPrReview } = await import('../pr-review/run.js');
    return await runPrReview(operationContext);
  }

  if (operation === 'pr-address-review') {
    const { runPrAddressReview } = await import('../pr-address-review/run.js');
    return await runPrAddressReview(operationContext);
  }

  const { runPrFinalize } = await import('../pr-finalize/run.js');
  return await runPrFinalize(operationContext);
}

/**
 * @param {OperationRunnerContext} context
 * @param {{
 *   pullRequestNumber: number,
 *   operation: PullRequestOperationName,
 *   resumeParentPrdAutomationAfterPrFinalize?: boolean,
 * }} options
 * @returns {OperationRunnerContext}
 */
function createPullRequestOperationContext(
  context,
  { pullRequestNumber, operation, resumeParentPrdAutomationAfterPrFinalize },
) {
  const configKey = readPullRequestOperationConfigKey(operation);
  const modelTier = context.config.operations[configKey].modelTier;
  return {
    ...context,
    operation,
    target: {
      type: 'pr',
      number: pullRequestNumber,
    },
    modelTier,
    model: context.config.runner.models[modelTier],
    ...(operation === 'pr-finalize' ? { allowAbsentReviewedHeadChecks: true } : {}),
    suppressFollowUpOperationLabels: true,
    ...(resumeParentPrdAutomationAfterPrFinalize === undefined
      ? {}
      : { resumeParentPrdAutomationAfterPrFinalize }),
  };
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
