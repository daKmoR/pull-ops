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
    'pullops:coordinate is reserved for a later automatic parent/child orchestration slice.',
    'Use pullops:prepare on the parent issue now, then label selected concrete child issues with pullops:implement.',
  ].join(' ');

  await context.githubClient.commentOnIssue({
    number: issue.number,
    body: summary,
  });
  await context.githubClient.removeLabelsFromIssue({
    number: issue.number,
    labels: ['pullops:coordinate', 'pullops:in-progress'],
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
