/**
 * @typedef {import('../cli/types.js').OperationRunnerContext} OperationRunnerContext
 */

/**
 * @param {OperationRunnerContext} context
 * @param {{ operation: string, summary?: string }} options
 * @returns {string}
 */
export function createOperationAuditComment(context, { operation, summary }) {
  const auditDetails = createOperationAuditDetails(context, { operation });
  const trimmedSummary = summary?.trim() || `PullOps ran \`${operation}\`.`;

  return [trimmedSummary, '', '---', '', auditDetails].join('\n');
}

/**
 * @param {string} body
 * @param {OperationRunnerContext} context
 * @param {{ operation: string }} options
 * @returns {string}
 */
export function appendOperationAuditFooter(body, context, { operation }) {
  return [body.trimEnd(), '', '---', '', createOperationAuditDetails(context, { operation })].join(
    '\n',
  );
}

/**
 * @param {OperationRunnerContext} context
 * @param {{ pullRequestNumber: number, operation: string, summary?: string }} options
 * @returns {Promise<void>}
 */
export async function commentOnPullRequestWithOperationAudit(
  context,
  { pullRequestNumber, operation, summary },
) {
  await context.githubClient.commentOnPullRequest({
    number: pullRequestNumber,
    body: createOperationAuditComment(context, { operation, summary }),
  });
}

/**
 * @param {OperationRunnerContext} context
 * @param {{ operation: string }} options
 * @returns {string}
 */
function createOperationAuditDetails(context, { operation }) {
  return [
    '<details>',
    '<summary>PullOps operation audit</summary>',
    '',
    `Operation: ${operation}`,
    `Trigger actor: ${formatActor(context.triggerActor)}`,
    `Model tier: ${context.modelTier}`,
    `Model: ${context.model}`,
    ...formatReasoningEffort(context.reasoningEffort),
    `Context used: ${formatContextUsage(context.contextUsage)}`,
    '</details>',
  ].join('\n');
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

  if (contextUsage.limit === undefined) {
    return `${contextUsage.used} tokens`;
  }

  return `${contextUsage.used} / ${contextUsage.limit} tokens`;
}
