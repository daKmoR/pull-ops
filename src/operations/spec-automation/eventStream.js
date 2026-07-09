/**
 * @typedef {import('../../cli/types.js').OperationContextUsage} OperationContextUsage
 * @typedef {import('../../run-supervision/types.js').OperationProgressEventName} OperationProgressEventName
 * @typedef {import('../../spec-automation/ticketCoordination.types.js').TicketAutomationResult} TicketAutomationResult
 * @typedef {import('../../spec-automation/ticketCoordination.types.js').SpecAutomationResult} SpecAutomationResult
 */

/**
 * @param {TicketAutomationResult} ticket
 * @returns {{
 *   event: OperationProgressEventName,
 *   details: Record<string, unknown>,
 * }}
 */
export function createLocalSpecAutoCompleteTicketProgressEvent(ticket) {
  return {
    event: readTicketProgressEventName(ticket),
    details: {
      phase: 'ticket-coordination',
      ticket: ticket.issue,
      status: ticket.status,
      message: ticket.summary,
      ...projectTicketResult(ticket),
    },
  };
}

/**
 * @param {{
 *   tickets: TicketAutomationResult[],
 *   targetNumber: number,
 * }} options
 * @returns {Record<string, unknown>}
 */
export function createLocalSpecAutoCompletePhaseCompletedEvent({ tickets, targetNumber }) {
  return {
    phase: 'ticket-coordination',
    ticketCounts: summarizeTicketCounts(tickets),
    message: summarizeTicketCoordination(tickets, targetNumber),
  };
}

/**
 * @param {{
 *   status?: string,
 *   summary?: string,
 *   pullRequest?: { number: number, url: string, baseBranch?: string, headBranch: string },
 *   nextOperation?: string,
 * } | undefined} parentPullRequest
 * @returns {Record<string, unknown> | undefined}
 */
export function createLocalSpecAutoCompleteParentWaitingEvent(parentPullRequest) {
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
 * @param {SpecAutomationResult} result
 * @param {{
 *   operationLabelReference: string,
 *   target: { type: 'issue', number: number },
 *   startedAt: Date,
 *   finishedAt: Date,
 *   contextUsage?: OperationContextUsage | null,
 * }} options
 * @returns {Record<string, unknown>}
 */
export function createLocalSpecAutoCompleteSummary(result, options) {
  const tickets = readTicketResults(result.tickets);

  if (result.status === 'failed') {
    return {
      ...result,
      contextUsage: options.contextUsage ?? null,
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
      contextUsage: options.contextUsage ?? null,
      startedAt: options.startedAt.toISOString(),
      finishedAt: options.finishedAt.toISOString(),
      durationMs: Math.max(0, options.finishedAt.getTime() - options.startedAt.getTime()),
      reason: readTerminalRefusalReason(result),
      displayMessage: readTerminalDisplayMessage(result),
      nextSteps: readTerminalNextSteps(result),
      suggestedActions: readTerminalSuggestedActions(result),
    };
  }

  const blockers = collectTerminalBlockers(result, tickets, options);
  const terminalStatus = readTerminalStatus(result, blockers);
  const summary = {
    ...result,
    status: terminalStatus,
    contextUsage: options.contextUsage ?? null,
    startedAt: options.startedAt.toISOString(),
    finishedAt: options.finishedAt.toISOString(),
    durationMs: Math.max(0, options.finishedAt.getTime() - options.startedAt.getTime()),
  };

  if (terminalStatus !== 'blocked') {
    return summary;
  }

  return {
    ...summary,
    status: 'blocked',
    blockers: blockers.length > 0 ? blockers : [createFallbackTerminalBlocker(result, options)],
    nextSteps: readTerminalNextSteps(result),
    suggestedActions: buildSuggestedActions(result, options, blockers),
  };
}

/**
 * @param {TicketAutomationResult[] | undefined} tickets
 * @returns {TicketAutomationResult[]}
 */
function readTicketResults(tickets) {
  return Array.isArray(tickets) ? tickets : [];
}

/**
 * @param {TicketAutomationResult} ticket
 * @returns {Partial<TicketAutomationResult>}
 */
function projectTicketResult(ticket) {
  return {
    ...(ticket.blockedBy === undefined ? {} : { blockedBy: ticket.blockedBy }),
    ...(ticket.blockedPhase === undefined ? {} : { blockedPhase: ticket.blockedPhase }),
    ...(ticket.blockedOperation === undefined ? {} : { blockedOperation: ticket.blockedOperation }),
    ...(ticket.dependencyDecision === undefined
      ? {}
      : { dependencyDecision: ticket.dependencyDecision }),
    ...(ticket.labels === undefined ? {} : { labels: ticket.labels }),
    ...(ticket.branch === undefined ? {} : { branch: ticket.branch }),
    ...(ticket.localRunRecord === undefined ? {} : { localRunRecord: ticket.localRunRecord }),
    ...(ticket.publicationMode === undefined ? {} : { publicationMode: ticket.publicationMode }),
    ...(ticket.pullRequest === undefined ? {} : { pullRequest: ticket.pullRequest }),
    ...(ticket.nextOperation === undefined ? {} : { nextOperation: ticket.nextOperation }),
    ...(ticket.checks === undefined ? {} : { checks: ticket.checks }),
    ...(ticket.mergeMethod === undefined ? {} : { mergeMethod: ticket.mergeMethod }),
    ...(ticket.conflictedFiles === undefined ? {} : { conflictedFiles: ticket.conflictedFiles }),
    ...(ticket.finalizedHeadSha === undefined ? {} : { finalizedHeadSha: ticket.finalizedHeadSha }),
    ...(ticket.headSha === undefined ? {} : { headSha: ticket.headSha }),
    ...(ticket.treeHash === undefined ? {} : { treeHash: ticket.treeHash }),
  };
}

/**
 * @param {TicketAutomationResult[]} tickets
 * @returns {{ total: number, completed: number, blocked: number, waiting?: number }}
 */
function summarizeTicketCounts(tickets) {
  const waiting = tickets.filter(ticket => isWaitingTicketStatus(ticket.status)).length;
  const blocked = tickets.filter(ticket => isBlockedTicketStatus(ticket.status)).length;
  const completed = Math.max(0, tickets.length - waiting - blocked);
  return {
    total: tickets.length,
    completed,
    blocked,
    ...(waiting === 0 ? {} : { waiting }),
  };
}

/**
 * @param {TicketAutomationResult[]} tickets
 * @param {number} issueNumber
 * @returns {string}
 */
function summarizeTicketCoordination(tickets, issueNumber) {
  const counts = summarizeTicketCounts(tickets);
  if (counts.total === 0) {
    return `Coordinated 0 ticket(s) for issue #${issueNumber}.`;
  }

  return `Coordinated ${counts.total} ticket(s) for issue #${issueNumber}: ${counts.completed} completed, ${counts.blocked} blocked${
    counts.waiting === undefined ? '.' : `, ${counts.waiting} waiting.`
  }`;
}

/**
 * @param {string} status
 * @returns {boolean}
 */
function isBlockedTicketStatus(status) {
  return status === 'blocked' || status === 'human-required' || status === 'routed-to-ci-repair';
}

/**
 * @param {string} status
 * @returns {boolean}
 */
function isWaitingTicketStatus(status) {
  return status === 'waiting';
}

/**
 * @param {TicketAutomationResult} ticket
 * @returns {OperationProgressEventName}
 */
function readTicketProgressEventName(ticket) {
  if (isWaitingTicketStatus(ticket.status)) {
    return 'waiting';
  }

  if (isBlockedTicketStatus(ticket.status)) {
    return 'ticket.blocked';
  }

  return 'ticket.completed';
}

/**
 * @param {SpecAutomationResult} result
 * @param {TicketAutomationResult[]} tickets
 * @param {{
 *   operationLabelReference: string,
 *   target: { type: 'issue', number: number },
 *   startedAt: Date,
 *   finishedAt: Date,
 *   contextUsage?: OperationContextUsage | null,
 * }} options
 * @returns {Record<string, unknown>[]}
 */
function collectTerminalBlockers(result, tickets, options) {
  /** @type {Record<string, unknown>[]} */
  const blockers = Array.isArray(result.blockers)
    ? result.blockers.map(blocker => ({ ...blocker }))
    : [];

  for (const ticket of tickets) {
    const blocker = readTicketTerminalBlocker(ticket);
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
 * @param {TicketAutomationResult} ticket
 * @returns {Record<string, unknown> | undefined}
 */
function readTicketTerminalBlocker(ticket) {
  if (isWaitingTicketStatus(ticket.status)) {
    if (ticket.runnerJob !== undefined) {
      return undefined;
    }

    return createRunBlocker({
      targetKind: ticket.pullRequest === undefined ? 'issue' : 'pull-request',
      targetNumber: ticket.pullRequest?.number ?? ticket.issue.number,
      phase: ticket.blockedPhase ?? 'review',
      operationLabelReference: normalizeOperationLabelReference(
        ticket.blockedOperation ??
          (ticket.pullRequest === undefined ? 'issue:implement' : 'pr:review'),
      ),
      reason: readWaitingReason(ticket.blockedPhase),
      message: ticket.summary,
      retryable: true,
    });
  }

  if (ticket.status === 'human-required') {
    return createRunBlocker({
      targetKind: ticket.pullRequest === undefined ? 'issue' : 'pull-request',
      targetNumber: ticket.pullRequest?.number ?? ticket.issue.number,
      phase: ticket.blockedPhase ?? 'ticket-coordination',
      operationLabelReference: normalizeOperationLabelReference(
        ticket.blockedOperation ??
          (ticket.pullRequest === undefined ? 'issue:implement' : 'pr:review'),
      ),
      reason: 'human-required',
      message: ticket.summary,
      retryable: true,
    });
  }

  if (ticket.status === 'routed-to-ci-repair') {
    return createRunBlocker({
      targetKind: ticket.pullRequest === undefined ? 'issue' : 'pull-request',
      targetNumber: ticket.pullRequest?.number ?? ticket.issue.number,
      phase: ticket.blockedPhase ?? 'checks',
      operationLabelReference: 'pr:fix-ci',
      reason: 'ci-repair',
      message: ticket.summary,
      retryable: true,
    });
  }

  if (ticket.status !== 'blocked') {
    return undefined;
  }

  if (isDependencyFrontierTicketBlock(ticket)) {
    return createRunBlocker({
      targetKind: 'issue',
      targetNumber: ticket.issue.number,
      phase: 'dependency',
      operationLabelReference: 'issue:implement',
      reason: 'dependency-wait',
      message: ticket.summary,
      retryable: true,
    });
  }

  return createRunBlocker({
    targetKind: ticket.pullRequest === undefined ? 'issue' : 'pull-request',
    targetNumber: ticket.pullRequest?.number ?? ticket.issue.number,
    phase: ticket.blockedPhase ?? 'ticket-coordination',
    operationLabelReference: normalizeOperationLabelReference(
      ticket.blockedOperation ??
        (ticket.pullRequest === undefined ? 'issue:implement' : 'spec:auto-complete'),
    ),
    reason: readBlockedReason(ticket.blockedPhase),
    message: ticket.summary,
    retryable: true,
  });
}

/**
 * @param {TicketAutomationResult} ticket
 * @returns {boolean}
 */
function isDependencyFrontierTicketBlock(ticket) {
  if (ticket.blockedPhase === 'dependency') {
    return true;
  }

  return (
    Array.isArray(ticket.blockedBy) &&
    ticket.blockedBy.length > 0 &&
    Array.isArray(ticket.dependencyDecision?.remainingBlockedBy) &&
    ticket.dependencyDecision.remainingBlockedBy.length > 0
  );
}

/**
 * @param {{
 *   status?: string,
 *   summary?: string,
 *   pullRequest?: { number: number },
 *   nextOperation?: string,
 *   runnerJob?: import('../../runner/types.js').ExternalRunnerJob
 *     | import('../../runner/types.js').ExternalRunnerJobReference,
 * } | undefined} parentPullRequest
 * @param {string} operationLabelReference
 * @returns {Record<string, unknown> | undefined}
 */
function readParentTerminalBlocker(parentPullRequest, operationLabelReference) {
  if (parentPullRequest === undefined) {
    return undefined;
  }

  if (parentPullRequest.runnerJob !== undefined) {
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
 * @param {SpecAutomationResult} result
 * @returns {string[]}
 */
function readTerminalNextSteps(result) {
  if (Array.isArray(result.nextSteps)) {
    return result.nextSteps;
  }

  return Array.isArray(result.localNextSteps) ? result.localNextSteps : [];
}

/**
 * @param {SpecAutomationResult} result
 * @returns {string}
 */
function readTerminalRefusalReason(result) {
  return typeof result.refusalReason === 'string' && result.refusalReason.trim() !== ''
    ? result.refusalReason
    : 'refused';
}

/**
 * @param {SpecAutomationResult} result
 * @returns {string}
 */
function readTerminalDisplayMessage(result) {
  return typeof result.displayMessage === 'string' && result.displayMessage.trim() !== ''
    ? result.displayMessage
    : String(result.summary);
}

/**
 * @param {SpecAutomationResult} result
 * @returns {string}
 */
function readTerminalFailureReason(result) {
  return typeof result.failureReason === 'string' && result.failureReason.trim() !== ''
    ? result.failureReason
    : String(result.summary);
}

/**
 * @param {SpecAutomationResult} result
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
 * @param {SpecAutomationResult} result
 * @param {{
 *   operationLabelReference: string,
 *   target: { type: 'issue', number: number },
 *   startedAt: Date,
 *   finishedAt: Date,
 *   contextUsage?: OperationContextUsage | null,
 * }} options
 * @param {Record<string, unknown>[]} blockers
 * @returns {Record<string, unknown>[]}
 */
function buildSuggestedActions(result, options, blockers) {
  const command = ['pullops', 'run', 'spec:auto-complete', String(options.target.number)];
  if (result.publicationMode === 'publish') {
    command.push('--publish', 'pr');
  }

  const firstBlocker = blockers[0];
  const description =
    typeof firstBlocker?.reason === 'string' &&
    firstBlocker.reason.includes('wait') &&
    firstBlocker.reason !== 'dependency-wait'
      ? 'Rerun Spec auto-complete after the waiting boundary clears.'
      : 'Rerun Spec auto-complete after the blocker is resolved.';

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
 * @param {SpecAutomationResult} result
 * @param {Record<string, unknown>[]} blockers
 * @returns {'accepted' | 'blocked' | 'waiting'}
 */
function readTerminalStatus(result, blockers) {
  if (result.status === 'waiting') {
    return 'waiting';
  }

  return result.status === 'blocked' || blockers.length > 0 ? 'blocked' : 'accepted';
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
 * @param {SpecAutomationResult} result
 * @param {{
 *   operationLabelReference: string,
 *   target: { type: 'issue', number: number },
 *   startedAt: Date,
 *   finishedAt: Date,
 *   contextUsage?: OperationContextUsage | null,
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
