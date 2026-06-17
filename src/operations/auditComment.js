/**
 * @typedef {import('../cli/types.js').OperationRunnerContext} OperationRunnerContext
 */

/**
 * @param {OperationRunnerContext} context
 * @param {{ operation: string }} options
 * @returns {string}
 */
export function createOperationAuditComment(context, { operation }) {
  return [
    '## PullOps Operation Audit',
    '',
    `Operation: ${operation}`,
    `Trigger actor: ${formatActor(context.triggerActor)}`,
    `Model tier: ${context.modelTier}`,
    `Model: ${context.model}`,
    ...formatReasoningEffort(context.reasoningEffort),
    `Context used: ${formatContextUsage(context.contextUsage)}`,
  ].join('\n');
}

/**
 * @param {string} body
 * @param {OperationRunnerContext} context
 * @param {{ operation: string }} options
 * @returns {string}
 */
export function appendOperationAuditFooter(body, context, { operation }) {
  return [body.trimEnd(), '', '---', '', createOperationAuditComment(context, { operation })].join(
    '\n',
  );
}

/**
 * @param {OperationRunnerContext} context
 * @param {{ pullRequestNumber: number, operation: string }} options
 * @returns {Promise<void>}
 */
export async function commentOnPullRequestWithOperationAudit(
  context,
  { pullRequestNumber, operation },
) {
  await context.githubClient.commentOnPullRequest({
    number: pullRequestNumber,
    body: createOperationAuditComment(context, { operation }),
  });
}

/**
 * @param {string | undefined} actor
 * @returns {string}
 */
function formatActor(actor) {
  if (actor === undefined || actor.trim() === '') {
    return 'unknown';
  }

  return actor.startsWith('@') ? actor : `@${actor}`;
}

/**
 * @param {string | undefined} reasoningEffort
 * @returns {string[]}
 */
function formatReasoningEffort(reasoningEffort) {
  if (reasoningEffort === undefined || reasoningEffort.trim() === '') {
    return [];
  }

  return [`Reasoning effort: ${reasoningEffort}`];
}

/**
 * @param {import('../cli/types.js').OperationContextUsage | undefined} contextUsage
 * @returns {string}
 */
function formatContextUsage(contextUsage) {
  if (contextUsage === undefined) {
    return 'unknown';
  }

  return `${contextUsage.used} / ${contextUsage.limit} tokens`;
}
