import { PULL_OPS_OPERATION_LABELS, PULL_OPS_STATUS_LABELS } from '../../labels/pullOpsLabels.js';

/**
 * @typedef {import('../../cli/types.js').OperationRunnerContext} OperationRunnerContext
 */

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
export async function runCoordinatePrd(context) {
  assertIssueTarget(context);

  const issue = await context.githubClient.getIssue(context.target.number);
  const summary = [
    `${PULL_OPS_OPERATION_LABELS.coordinatePrd} is reserved for a later automatic parent/child orchestration slice.`,
    [
      `Use ${PULL_OPS_OPERATION_LABELS.preparePrd} on the parent issue now,`,
      `then label selected concrete child issues with ${PULL_OPS_OPERATION_LABELS.implementIssue}.`,
    ].join(' '),
  ].join(' ');

  await context.githubClient.commentOnIssue({
    number: issue.number,
    body: summary,
  });
  await context.githubClient.removeLabelsFromIssue({
    number: issue.number,
    labels: [PULL_OPS_OPERATION_LABELS.coordinatePrd, PULL_OPS_STATUS_LABELS.inProgress],
  });

  return {
    status: 'reserved',
    summary,
    issue: issue.number,
  };
}

/**
 * @param {OperationRunnerContext} context
 * @returns {asserts context is OperationRunnerContext & { target: { type: 'issue', number: number } }}
 */
function assertIssueTarget(context) {
  if (context.target.type !== 'issue') {
    throw new Error('coordinate-prd requires an issue target.');
  }
}
