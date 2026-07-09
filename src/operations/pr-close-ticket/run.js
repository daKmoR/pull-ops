import { closeMergedTicketPullRequest } from '../../spec-automation/ticketCoordination.js';
import { runLocalPullRequestOperation } from '../runLocalPullRequestOperation.js';

/**
 * @typedef {import('../../cli/types.js').OperationRunnerContext} OperationRunnerContext
 */

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
export async function runPrCloseTicket(context) {
  if (context.executionBackend === 'local' && context.publicationMode !== 'publish') {
    return await runLocalPullRequestOperation(context);
  }

  assertPullRequestTarget(context);
  return await closeMergedTicketPullRequest(context, {
    pullRequestNumber: context.target.number,
  });
}

/**
 * @param {OperationRunnerContext} context
 * @returns {asserts context is OperationRunnerContext & { target: { type: 'pr', number: number } }}
 */
function assertPullRequestTarget(context) {
  if (context.target.type !== 'pr') {
    throw new Error('pr-close-ticket requires a pull request target.');
  }
}
