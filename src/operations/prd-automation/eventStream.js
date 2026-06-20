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
  pushEvent(events, identity, 'run.started', {
    phase: 'run',
    message: `Starting local PRD auto-complete for issue #${options.target.number}.`,
  });
  pushEvent(events, identity, 'phase.started', {
    phase: 'child-coordination',
    message: `Coordinating ${children.length} child issue(s) for issue #${options.target.number}.`,
  });

  if (result.status !== 'failed') {
    for (const child of children) {
      pushEvent(events, identity, 'child.started', {
        phase: 'child-coordination',
        childIssue: child.issue,
        message: `Coordinating child issue #${child.issue.number}.`,
      });
      pushEvent(events, identity, readChildProgressEventName(child), {
        phase: 'child-coordination',
        childIssue: child.issue,
        status: child.status,
        message: child.summary,
        ...projectChildResult(child),
      });
    }

    pushEvent(events, identity, 'phase.completed', {
      phase: 'child-coordination',
      childCounts: summarizeChildCounts(children),
      message: summarizeChildCoordination(children, options.target.number),
    });

    const parentWaitingEvent = readParentWaitingEvent(result.parentPullRequest);
    if (parentWaitingEvent !== undefined) {
      pushEvent(events, identity, 'waiting', parentWaitingEvent);
    }
  }

  const summary = createTerminalSummary(result, options, children);
  events.push(summary);

  const timeline = createTimeline(options.startedAt, options.finishedAt, events.length);
  const stampedEvents = stampEvents(events, timeline);

  return {
    events: stampedEvents,
    eventsJsonl: stampedEvents.map(event => JSON.stringify(event)).join('\n'),
    summary: stampedEvents[stampedEvents.length - 1] ?? summary,
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
 * @param {Record<string, unknown>} identity
 * @param {string} event
 * @param {Record<string, unknown>} details
 * @returns {void}
 */
function pushEvent(events, identity, event, details) {
  events.push({
    schemaVersion: identity.schemaVersion,
    event,
    runId: identity.runId,
    operation: identity.operation,
    operationLabelReference: identity.operationLabelReference,
    target: identity.target,
    ...(identity.mode === undefined ? {} : { mode: identity.mode }),
    ...(identity.publicationMode === undefined
      ? {}
      : { publicationMode: identity.publicationMode }),
    ...details,
  });
}

/**
 * @param {Record<string, unknown>[]} events
 * @param {string[]} timeline
 * @returns {Record<string, unknown>[]}
 */
function stampEvents(events, timeline) {
  return events.map((event, index) => ({
    ...event,
    at: timeline[index],
  }));
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
    ...(child.dependencyDecision === undefined
      ? {}
      : { dependencyDecision: child.dependencyDecision }),
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
 * @returns {{ total: number, completed: number, blocked: number, waiting?: number }}
 */
function summarizeChildCounts(children) {
  const waiting = children.filter(child => isWaitingChildStatus(child.status)).length;
  const blocked = children.filter(child => isBlockedChildStatus(child.status)).length;
  const completed = Math.max(0, children.length - waiting - blocked);
  return {
    total: children.length,
    completed,
    blocked,
    ...(waiting === 0 ? {} : { waiting }),
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

  return `Coordinated ${counts.total} child issue(s) for issue #${issueNumber}: ${counts.completed} completed, ${counts.blocked} blocked${
    counts.waiting === undefined ? '.' : `, ${counts.waiting} waiting.`
  }`;
}

/**
 * @param {string} status
 * @returns {boolean}
 */
function isBlockedChildStatus(status) {
  return status === 'blocked' || status === 'human-required' || status === 'routed-to-ci-repair';
}

/**
 * @param {string} status
 * @returns {boolean}
 */
function isWaitingChildStatus(status) {
  return status === 'waiting';
}

/**
 * @param {ChildAutomationResult} child
 * @returns {'waiting' | 'child.blocked' | 'child.completed'}
 */
function readChildProgressEventName(child) {
  if (isWaitingChildStatus(child.status)) {
    return 'waiting';
  }

  if (isBlockedChildStatus(child.status)) {
    return 'child.blocked';
  }

  return 'child.completed';
}

/**
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
 * @param {ChildAutomationResult[]} children
 * @returns {Record<string, unknown>}
 */
function createTerminalSummary(result, options, children) {
  if (result.status === 'failed') {
    return {
      ...result,
      schemaVersion: 1,
      event: 'run.summary',
      runId: options.runId,
      operation: options.operation,
      operationLabelReference: options.operationLabelReference,
      target: options.target,
      ...(result.mode === undefined ? {} : { mode: result.mode }),
      ...(result.publicationMode === undefined ? {} : { publicationMode: result.publicationMode }),
      ...(options.contextUsage === undefined ? {} : { contextUsage: options.contextUsage }),
      startedAt: options.startedAt.toISOString(),
      finishedAt: options.finishedAt.toISOString(),
      durationMs: Math.max(0, options.finishedAt.getTime() - options.startedAt.getTime()),
      displayMessage: readTerminalDisplayMessage(result),
      failureReason: readTerminalFailureReason(result),
    };
  }

  if (result.status === 'refused') {
    return {
      ...result,
      schemaVersion: 1,
      event: 'run.summary',
      runId: options.runId,
      operation: options.operation,
      operationLabelReference: options.operationLabelReference,
      target: options.target,
      ...(result.mode === undefined ? {} : { mode: result.mode }),
      ...(result.publicationMode === undefined ? {} : { publicationMode: result.publicationMode }),
      ...(options.contextUsage === undefined ? {} : { contextUsage: options.contextUsage }),
      startedAt: options.startedAt.toISOString(),
      finishedAt: options.finishedAt.toISOString(),
      durationMs: Math.max(0, options.finishedAt.getTime() - options.startedAt.getTime()),
      reason: readTerminalRefusalReason(result),
      displayMessage: readTerminalDisplayMessage(result),
      nextSteps: readTerminalNextSteps(result),
      suggestedActions: readTerminalSuggestedActions(result),
    };
  }

  const blockers = collectTerminalBlockers(result, children, options);
  const blocked = result.status === 'blocked' || blockers.length > 0;
  const summary = {
    ...result,
    schemaVersion: 1,
    event: 'run.summary',
    runId: options.runId,
    operation: options.operation,
    operationLabelReference: options.operationLabelReference,
    target: options.target,
    ...(result.mode === undefined ? {} : { mode: result.mode }),
    ...(result.publicationMode === undefined ? {} : { publicationMode: result.publicationMode }),
    ...(options.contextUsage === undefined ? {} : { contextUsage: options.contextUsage }),
    startedAt: options.startedAt.toISOString(),
    finishedAt: options.finishedAt.toISOString(),
    durationMs: Math.max(0, options.finishedAt.getTime() - options.startedAt.getTime()),
  };

  if (!blocked) {
    return summary;
  }

  return {
    ...summary,
    status: 'blocked',
    blockers: blockers.length > 0 ? blockers : [createFallbackTerminalBlocker(result, options)],
    nextSteps: readTerminalNextSteps(result),
    suggestedActions: buildSuggestedActions(result, options),
  };
}

/**
 * @param {PrdAutomationResult} result
 * @param {ChildAutomationResult[]} children
 * @param {{
 *   operation: 'prd-auto-complete',
 *   operationLabelReference: string,
 *   runId: string,
 *   target: { type: 'issue', number: number },
 *   startedAt: Date,
 *   finishedAt: Date,
 *   contextUsage?: OperationContextUsage,
 * }} options
 * @returns {Record<string, unknown>[]}
 */
function collectTerminalBlockers(result, children, options) {
  /** @type {Record<string, unknown>[]} */
  const blockers = [];

  for (const child of children) {
    const blocker = readChildTerminalBlocker(child);
    if (blocker !== undefined) {
      blockers.push(blocker);
    }
  }

  const parentBlocker = readParentTerminalBlocker(
    result.parentPullRequest,
    options.operationLabelReference,
  );
  if (parentBlocker !== undefined) {
    blockers.push(parentBlocker);
  }

  return blockers;
}

/**
 * @param {ChildAutomationResult} child
 * @returns {Record<string, unknown> | undefined}
 */
function readChildTerminalBlocker(child) {
  if (isWaitingChildStatus(child.status)) {
    return createRunBlocker({
      targetKind: child.pullRequest === undefined ? 'issue' : 'pull-request',
      targetNumber: child.pullRequest?.number ?? child.issue.number,
      phase: child.blockedPhase ?? 'review',
      operationLabelReference: normalizeOperationLabelReference(
        child.blockedOperation ??
          (child.pullRequest === undefined ? 'issue:implement' : 'pr:review'),
      ),
      reason: readWaitingReason(child.blockedPhase),
      message: child.summary,
      retryable: true,
    });
  }

  if (child.status === 'human-required') {
    return createRunBlocker({
      targetKind: child.pullRequest === undefined ? 'issue' : 'pull-request',
      targetNumber: child.pullRequest?.number ?? child.issue.number,
      phase: child.blockedPhase ?? 'child-coordination',
      operationLabelReference: normalizeOperationLabelReference(
        child.blockedOperation ??
          (child.pullRequest === undefined ? 'issue:implement' : 'pr:review'),
      ),
      reason: 'human-required',
      message: child.summary,
      retryable: true,
    });
  }

  if (child.status === 'routed-to-ci-repair') {
    return createRunBlocker({
      targetKind: child.pullRequest === undefined ? 'issue' : 'pull-request',
      targetNumber: child.pullRequest?.number ?? child.issue.number,
      phase: child.blockedPhase ?? 'checks',
      operationLabelReference: 'pr:fix-ci',
      reason: 'ci-repair',
      message: child.summary,
      retryable: true,
    });
  }

  if (child.status !== 'blocked') {
    return undefined;
  }

  // Dependency blocks are frontier gaps already handled in accepted streams; they do not
  // become terminal blocked summaries here.
  if (isDependencyFrontierChildBlock(child)) {
    return undefined;
  }

  return createRunBlocker({
    targetKind: child.pullRequest === undefined ? 'issue' : 'pull-request',
    targetNumber: child.pullRequest?.number ?? child.issue.number,
    phase: child.blockedPhase ?? 'child-coordination',
    operationLabelReference: normalizeOperationLabelReference(
      child.blockedOperation ??
        (child.pullRequest === undefined ? 'issue:implement' : 'prd:auto-complete'),
    ),
    reason: readBlockedReason(child.blockedPhase),
    message: child.summary,
    retryable: true,
  });
}

/**
 * @param {ChildAutomationResult} child
 * @returns {boolean}
 */
function isDependencyFrontierChildBlock(child) {
  if (child.blockedPhase === 'dependency') {
    return true;
  }

  return (
    Array.isArray(child.blockedBy) &&
    child.blockedBy.length > 0 &&
    Array.isArray(child.dependencyDecision?.remainingBlockedBy) &&
    child.dependencyDecision.remainingBlockedBy.length > 0
  );
}

/**
 * @param {{
 *   status?: string,
 *   summary?: string,
 *   pullRequest?: { number: number },
 *   nextOperation?: string,
 * } | undefined} parentPullRequest
 * @param {string} operationLabelReference
 * @returns {Record<string, unknown> | undefined}
 */
function readParentTerminalBlocker(parentPullRequest, operationLabelReference) {
  if (parentPullRequest === undefined) {
    return undefined;
  }

  if (parentPullRequest.status !== 'waiting' && parentPullRequest.status !== 'blocked') {
    return undefined;
  }

  const targetNumber =
    typeof parentPullRequest.pullRequest?.number === 'number'
      ? parentPullRequest.pullRequest.number
      : undefined;
  return createRunBlocker({
    targetKind: 'pull-request',
    targetNumber,
    phase: readParentPullRequestPhase(parentPullRequest),
    operationLabelReference: normalizeOperationLabelReference(
      parentPullRequest.nextOperation ?? operationLabelReference,
    ),
    reason: parentPullRequest.status === 'waiting' ? 'waiting' : 'blocked',
    message:
      parentPullRequest.summary ??
      (targetNumber === undefined
        ? 'Umbrella PR automation is waiting on a follow-up action.'
        : `Umbrella PR #${targetNumber} is waiting on a follow-up action.`),
    retryable: true,
  });
}

/**
 * @param {{
 *   status?: string,
 *   summary?: string,
 *   pullRequest?: { number: number },
 *   nextOperation?: string,
 * } | undefined} parentPullRequest
 * @returns {Record<string, unknown> | undefined}
 */
function readParentWaitingEvent(parentPullRequest) {
  if (parentPullRequest === undefined || parentPullRequest.status !== 'waiting') {
    return undefined;
  }

  return {
    phase: readParentPullRequestPhase(parentPullRequest),
    status: parentPullRequest.status,
    message:
      parentPullRequest.summary ??
      (parentPullRequest.pullRequest?.number === undefined
        ? 'Umbrella PR automation is waiting on a follow-up action.'
        : `Umbrella PR #${parentPullRequest.pullRequest.number} is waiting on a follow-up action.`),
    ...(parentPullRequest.pullRequest === undefined
      ? {}
      : { pullRequest: parentPullRequest.pullRequest }),
    ...(parentPullRequest.nextOperation === undefined
      ? {}
      : { nextOperation: normalizeOperationLabelReference(parentPullRequest.nextOperation) }),
  };
}

/**
 * @param {PrdAutomationResult} result
 * @returns {string[]}
 */
function readTerminalNextSteps(result) {
  if (Array.isArray(result.nextSteps)) {
    return result.nextSteps;
  }

  return Array.isArray(result.localNextSteps) ? result.localNextSteps : [];
}

/**
 * @param {PrdAutomationResult} result
 * @returns {string}
 */
function readTerminalRefusalReason(result) {
  return typeof result.refusalReason === 'string' && result.refusalReason.trim() !== ''
    ? result.refusalReason
    : 'refused';
}

/**
 * @param {PrdAutomationResult} result
 * @returns {string}
 */
function readTerminalDisplayMessage(result) {
  return typeof result.displayMessage === 'string' && result.displayMessage.trim() !== ''
    ? result.displayMessage
    : String(result.summary);
}

/**
 * @param {PrdAutomationResult} result
 * @returns {string}
 */
function readTerminalFailureReason(result) {
  return typeof result.failureReason === 'string' && result.failureReason.trim() !== ''
    ? result.failureReason
    : String(result.summary);
}

/**
 * @param {PrdAutomationResult} result
 * @returns {Record<string, unknown>[]}
 */
function readTerminalSuggestedActions(result) {
  if (!Array.isArray(result.suggestedActions)) {
    return [];
  }

  return result.suggestedActions.map(action =>
    createSuggestedCommandAction({
      description: action.description,
      argv: action.argv,
      approvalRequired: action.approvalRequired,
      ...(action.approvalReason === undefined ? {} : { approvalReason: action.approvalReason }),
    }),
  );
}

/**
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
 * @returns {Record<string, unknown>[]}
 */
function buildSuggestedActions(result, options) {
  const command = ['pullops', 'run', 'prd:auto-complete', String(options.target.number)];
  if (result.publicationMode === 'publish') {
    command.push('--publish', 'pr');
  }

  const firstBlocker = collectTerminalBlockers(
    result,
    readChildResults(result.children),
    options,
  )[0];
  const description =
    typeof firstBlocker?.reason === 'string' && firstBlocker.reason.includes('wait')
      ? 'Rerun PRD auto-complete after the waiting boundary clears.'
      : 'Rerun PRD auto-complete after the blocker is resolved.';

  return [
    createSuggestedCommandAction({
      description,
      argv: command,
      approvalRequired: false,
    }),
  ];
}

/**
 * @param {{
 *   targetKind: 'issue' | 'pull-request',
 *   targetNumber?: number,
 *   phase: string,
 *   operationLabelReference?: string,
 *   reason: string,
 *   message: string,
 *   retryable: boolean,
 * }} blocker
 * @returns {Record<string, unknown>}
 */
function createRunBlocker(blocker) {
  return {
    targetKind: blocker.targetKind,
    ...(blocker.targetNumber === undefined ? {} : { targetNumber: blocker.targetNumber }),
    phase: blocker.phase,
    ...(blocker.operationLabelReference === undefined
      ? {}
      : { operationLabelReference: blocker.operationLabelReference }),
    reason: blocker.reason,
    message: blocker.message,
    retryable: blocker.retryable,
  };
}

/**
 * @param {{
 *   description: string,
 *   argv: string[],
 *   approvalRequired: boolean,
 *   approvalReason?: string,
 * }} action
 * @returns {Record<string, unknown>}
 */
function createSuggestedCommandAction(action) {
  return {
    kind: 'command',
    description: action.description,
    argv: action.argv,
    approvalRequired: action.approvalRequired,
    ...(action.approvalReason === undefined ? {} : { approvalReason: action.approvalReason }),
  };
}

/**
 * @param {string | undefined} phase
 * @returns {string}
 */
function readWaitingReason(phase) {
  if (phase === 'checks') {
    return 'checks-wait';
  }

  if (phase === 'review' || phase === 'address-review') {
    return 'review-wait';
  }

  if (phase === 'integration') {
    return 'integration-wait';
  }

  if (phase === 'finalization') {
    return 'finalization-wait';
  }

  return 'waiting';
}

/**
 * @param {string | undefined} phase
 * @returns {string}
 */
function readBlockedReason(phase) {
  if (phase === 'checks') {
    return 'checks-failed';
  }

  if (phase === 'integration') {
    return 'integration-conflict';
  }

  if (phase === 'finalization') {
    return 'finalization-blocked';
  }

  if (phase === 'review' || phase === 'address-review') {
    return 'review-blocked';
  }

  return 'blocked';
}

/**
 * @param {{
 *   nextOperation?: string,
 * } | undefined} parentPullRequest
 * @returns {string}
 */
function readParentPullRequestPhase(parentPullRequest) {
  const nextOperation = normalizeOperationLabelReference(parentPullRequest?.nextOperation);
  if (nextOperation === 'pr:review') {
    return 'review';
  }

  if (nextOperation === 'pr:address-review') {
    return 'address-review';
  }

  if (nextOperation === 'pr:finalize') {
    return 'finalization';
  }

  return 'umbrella-pr';
}

/**
 * @param {string | undefined} reference
 * @returns {string | undefined}
 */
function normalizeOperationLabelReference(reference) {
  if (typeof reference !== 'string') {
    return undefined;
  }

  return reference.startsWith('pullops:') ? reference.slice('pullops:'.length) : reference;
}

/**
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
 * @returns {Record<string, unknown>}
 */
function createFallbackTerminalBlocker(result, options) {
  return createRunBlocker({
    targetKind: 'issue',
    targetNumber: options.target.number,
    phase: 'run',
    operationLabelReference: options.operationLabelReference,
    reason: 'blocked',
    message: String(result.summary),
    retryable: true,
  });
}
