/**
 * @typedef {import('../../cli/types.js').OperationContextUsage} OperationContextUsage
 * @typedef {import('../../prd-automation/childCoordination.types.js').ChildAutomationResult} ChildAutomationResult
 * @typedef {import('../../prd-automation/childCoordination.types.js').PrdAutomationResult} PrdAutomationResult
 */

/**
 * Build the local PRD auto-complete JSONL progress event stream.
 *
 * @param {PrdAutomationResult} result
 * @param {{
 *   operation: 'prd-auto-complete',
 *   operationLabelReference: string,
 *   runId: string,
 *   target: { type: 'issue', number: number },
 *   startedAt: Date,
 *   finishedAt: Date,
 *   contextUsage?: OperationContextUsage,
 * }} options
 * @returns {{
 *   events: Record<string, unknown>[],
 *   eventsJsonl: string,
 *   summary: Record<string, unknown>,
 * }}
 */
export function createLocalPrdAutoCompleteEventStream(result, options) {
  const children = readChildResults(result.children);
  const timeline = createTimeline(options.startedAt, options.finishedAt, 4 + children.length * 2);
  const identity = {
    schemaVersion: 1,
    runId: options.runId,
    operation: options.operation,
    operationLabelReference: options.operationLabelReference,
    target: options.target,
    ...(result.mode === undefined ? {} : { mode: result.mode }),
    ...(result.publicationMode === undefined ? {} : { publicationMode: result.publicationMode }),
  };

  /** @type {Record<string, unknown>[]} */
  const events = [];
  pushEvent(events, timeline, identity, 'run.started', {
    phase: 'run',
    message: `Starting local PRD auto-complete for issue #${options.target.number}.`,
  });
  pushEvent(events, timeline, identity, 'phase.started', {
    phase: 'child-coordination',
    message: `Coordinating ${children.length} child issue(s) for issue #${options.target.number}.`,
  });

  for (const child of children) {
    pushEvent(events, timeline, identity, 'child.started', {
      phase: 'child-coordination',
      childIssue: child.issue,
      message: `Coordinating child issue #${child.issue.number}.`,
    });
    pushEvent(events, timeline, identity, isBlockedChildStatus(child.status) ? 'child.blocked' : 'child.completed', {
      phase: 'child-coordination',
      childIssue: child.issue,
      status: child.status,
      message: child.summary,
      ...projectChildResult(child),
    });
  }

  pushEvent(events, timeline, identity, 'phase.completed', {
    phase: 'child-coordination',
    childCounts: summarizeChildCounts(children),
    message: summarizeChildCoordination(children, options.target.number),
  });

  const summary = {
    ...result,
    schemaVersion: 1,
    event: 'run.summary',
    runId: options.runId,
    operation: options.operation,
    operationLabelReference: options.operationLabelReference,
    target: options.target,
    at: options.finishedAt.toISOString(),
    startedAt: options.startedAt.toISOString(),
    finishedAt: options.finishedAt.toISOString(),
    durationMs: Math.max(0, options.finishedAt.getTime() - options.startedAt.getTime()),
    ...(options.contextUsage === undefined ? {} : { contextUsage: options.contextUsage }),
  };
  events.push(summary);

  return {
    events,
    eventsJsonl: events.map(event => JSON.stringify(event)).join('\n'),
    summary,
  };
}

/**
 * @param {ChildAutomationResult[] | undefined} children
 * @returns {ChildAutomationResult[]}
 */
function readChildResults(children) {
  return Array.isArray(children) ? children : [];
}

/**
 * @param {Date} startedAt
 * @param {Date} finishedAt
 * @param {number} totalEvents
 * @returns {string[]}
 */
function createTimeline(startedAt, finishedAt, totalEvents) {
  const startMs = startedAt.getTime();
  const finishMs = finishedAt.getTime();

  if (totalEvents <= 1 || finishMs <= startMs) {
    return Array.from({ length: totalEvents }, () => startedAt.toISOString());
  }

  const spanMs = finishMs - startMs;
  return Array.from({ length: totalEvents }, (_, index) => {
    const offsetMs = Math.round((spanMs * index) / (totalEvents - 1));
    return new Date(startMs + offsetMs).toISOString();
  });
}

/**
 * @param {Record<string, unknown>[]} events
 * @param {string[]} timeline
 * @param {Record<string, unknown>} identity
 * @param {string} event
 * @param {Record<string, unknown>} details
 * @returns {void}
 */
function pushEvent(events, timeline, identity, event, details) {
  events.push({
    schemaVersion: identity.schemaVersion,
    event,
    runId: identity.runId,
    operation: identity.operation,
    operationLabelReference: identity.operationLabelReference,
    target: identity.target,
    at: timeline[events.length],
    ...(identity.mode === undefined ? {} : { mode: identity.mode }),
    ...(identity.publicationMode === undefined ? {} : { publicationMode: identity.publicationMode }),
    ...details,
  });
}

/**
 * @param {ChildAutomationResult} child
 * @returns {Partial<ChildAutomationResult>}
 */
function projectChildResult(child) {
  return {
    ...(child.blockedBy === undefined ? {} : { blockedBy: child.blockedBy }),
    ...(child.blockedPhase === undefined ? {} : { blockedPhase: child.blockedPhase }),
    ...(child.blockedOperation === undefined ? {} : { blockedOperation: child.blockedOperation }),
    ...(child.dependencyDecision === undefined ? {} : { dependencyDecision: child.dependencyDecision }),
    ...(child.labels === undefined ? {} : { labels: child.labels }),
    ...(child.branch === undefined ? {} : { branch: child.branch }),
    ...(child.localRunRecord === undefined ? {} : { localRunRecord: child.localRunRecord }),
    ...(child.publicationMode === undefined ? {} : { publicationMode: child.publicationMode }),
    ...(child.pullRequest === undefined ? {} : { pullRequest: child.pullRequest }),
    ...(child.nextOperation === undefined ? {} : { nextOperation: child.nextOperation }),
    ...(child.checks === undefined ? {} : { checks: child.checks }),
    ...(child.mergeMethod === undefined ? {} : { mergeMethod: child.mergeMethod }),
    ...(child.conflictedFiles === undefined ? {} : { conflictedFiles: child.conflictedFiles }),
    ...(child.finalizedHeadSha === undefined ? {} : { finalizedHeadSha: child.finalizedHeadSha }),
    ...(child.headSha === undefined ? {} : { headSha: child.headSha }),
    ...(child.treeHash === undefined ? {} : { treeHash: child.treeHash }),
  };
}

/**
 * @param {ChildAutomationResult[]} children
 * @returns {{ total: number, completed: number, blocked: number }}
 */
function summarizeChildCounts(children) {
  const blocked = children.filter(child => isBlockedChildStatus(child.status)).length;
  return {
    total: children.length,
    completed: children.length - blocked,
    blocked,
  };
}

/**
 * @param {ChildAutomationResult[]} children
 * @param {number} issueNumber
 * @returns {string}
 */
function summarizeChildCoordination(children, issueNumber) {
  const counts = summarizeChildCounts(children);
  if (counts.total === 0) {
    return `Coordinated 0 child issue(s) for issue #${issueNumber}.`;
  }

  return `Coordinated ${counts.total} child issue(s) for issue #${issueNumber}: ${counts.completed} completed, ${counts.blocked} blocked.`;
}

/**
 * @param {string} status
 * @returns {boolean}
 */
function isBlockedChildStatus(status) {
  return status === 'blocked' || status === 'waiting' || status === 'human-required';
}
