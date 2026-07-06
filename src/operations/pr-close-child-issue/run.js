import { closeMergedChildIssuePullRequest } from '../../prd-automation/childCoordination.js';
import { runLocalPullRequestOperation } from '../runLocalPullRequestOperation.js';

/**
 * @typedef {import('../../cli/types.js').OperationRunnerContext} OperationRunnerContext
 */

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
export async function runPrCloseChildIssue(context) {
  if (context.executionBackend === 'local' && context.publicationMode !== 'publish') {
    return await runLocalPullRequestOperation(context);
  }

  assertPullRequestTarget(context);
  return await closeMergedChildIssuePullRequest(context, {
    pullRequestNumber: context.target.number,
  });
}

/**
 * @param {OperationRunnerContext} context
 * @returns {asserts context is OperationRunnerContext & { target: { type: 'pr', number: number } }}
 */
function assertPullRequestTarget(context) {
  if (context.target.type !== 'pr') {
    throw new Error('pr-close-child-issue requires a pull request target.');
  }
}
