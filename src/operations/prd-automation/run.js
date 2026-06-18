import {
  coordinatePrdAutomation,
  coordinateLocalPrdAutoAdvance,
  coordinateLocalPrdAutoComplete,
  resumePrdAutomationForParentIssue as resumePrdAutomation,
} from '../../prd-automation/childCoordination.js';
import { runIssueImplement } from '../issue-implement/run.js';

/**
 * @typedef {import('../../cli/types.js').OperationRunnerContext} OperationRunnerContext
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
      async runChildIssue(childIssueNumber) {
        return await runIssueImplement({
          ...localContext,
          operation: 'issue-implement',
          target: {
            type: 'issue',
            number: childIssueNumber,
          },
          publicationMode: localContext.publicationMode,
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
      async runChildIssue(childIssueNumber) {
        return await runIssueImplement({
          ...localContext,
          operation: 'issue-implement',
          target: {
            type: 'issue',
            number: childIssueNumber,
          },
          publicationMode: localContext.publicationMode,
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
 * Local PRD publication should produce Child Issue PRs that have completed automated review and
 * finalization, while dry-runs stay operation-only unless the caller explicitly asks otherwise.
 *
 * @param {OperationRunnerContext} context
 * @returns {OperationRunnerContext}
 */
function withDefaultLocalPrdRunGoal(context) {
  const publicationMode = context.publicationMode ?? 'dry-run';
  return {
    ...context,
    publicationMode,
    runGoal: context.runGoal ?? (publicationMode === 'publish' ? 'finalized' : 'operation'),
  };
}
