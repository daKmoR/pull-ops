import { appendFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import {
  LOCAL_RUN_STATE_FILE_NAME,
  updateLocalRunState,
} from '../../local-run-state/localRunState.js';

/**
 * @typedef {import('../../cli/types.js').WritableLike} WritableLike
 * @typedef {import('../../cli/types.js').OperationContextUsage} OperationContextUsage
 * @typedef {import('../../cli/types.js').OperationProgressEventName} OperationProgressEventName
 * @typedef {import('../../prd-automation/childCoordination.types.js').ChildAutomationResult} ChildAutomationResult
 * @typedef {import('../../prd-automation/childCoordination.types.js').PrdAutomationResult} PrdAutomationResult
 */

const OPERATION_PROGRESS_EVENT_NAMES = new Set(
  /** @type {OperationProgressEventName[]} */ ([
    'run.started',
    'phase.started',
    'phase.completed',
    'child.started',
    'child.progress',
    'child.heartbeat',
    'child.completed',
    'child.blocked',
    'waiting',
    'run.summary',
  ]),
);
const RESERVED_EVENT_DETAIL_KEYS = new Set([
  'schemaVersion',
  'event',
  'runId',
  'operation',
  'operationLabelReference',
  'target',
  'at',
]);
const RUN_STATE_SEMANTIC_EVENT_NAMES = new Set(
  /** @type {OperationProgressEventName[]} */ ([
    'run.started',
    'phase.started',
    'phase.completed',
    'child.started',
    'child.progress',
    'child.completed',
    'child.blocked',
    'waiting',
  ]),
);

/**
 * @param {{
 *   stdout: WritableLike,
 *   operation: string,
 *   operationLabelReference: string,
 *   runId: string,
 *   target: { type: 'issue' | 'pr', number: number },
 * }} options
 * @returns {import('../../cli/types.js').OperationProgressEventWriter}
 */
export function createOperationProgressEventWriter({
  stdout,
  operation,
  operationLabelReference,
  runId,
  target,
}) {
  let eventsText = '';
  /** @type {string | undefined} */
  let localRunRecord;
  /** @type {Record<string, unknown> | undefined} */
  let lastSemanticEvent;
  /** @type {Record<string, unknown> | undefined} */
  let terminalSummary;

  return {
    runId,
    operationLabelReference,
    target,
    async bindLocalRunRecord(nextLocalRunRecord) {
      const nextRunId = basename(nextLocalRunRecord);
      if (nextRunId !== runId) {
        throw new Error(
          `Progress event runId "${runId}" does not match Local Run Record "${nextRunId}".`,
        );
      }

      if (localRunRecord !== undefined && localRunRecord !== nextLocalRunRecord) {
        throw new Error(
          `Progress event writer already bound to "${localRunRecord}", cannot rebind to "${nextLocalRunRecord}".`,
        );
      }

      if (localRunRecord === nextLocalRunRecord) {
        return;
      }

      localRunRecord = nextLocalRunRecord;
      await writeFile(join(localRunRecord, 'events.jsonl'), eventsText);
      await writeLastSemanticEventToLocalRunState(localRunRecord, lastSemanticEvent);

      if (terminalSummary !== undefined) {
        await writeFile(
          join(localRunRecord, 'result.json'),
          `${JSON.stringify(terminalSummary, null, 2)}\n`,
        );
      }
    },
    async emit(event, details = {}) {
      assertOperationProgressEventName(event);
      assertNoReservedEventDetailKeys(details);
      const stampedEvent = {
        schemaVersion: 1,
        event,
        runId,
        operation,
        operationLabelReference,
        target,
        ...details,
        at: new Date().toISOString(),
      };
      const line = `${JSON.stringify(stampedEvent)}\n`;
      eventsText += line;
      stdout.write(line);

      if (localRunRecord !== undefined) {
        await appendFile(join(localRunRecord, 'events.jsonl'), line);
      }

      if (RUN_STATE_SEMANTIC_EVENT_NAMES.has(event)) {
        lastSemanticEvent = stampedEvent;
        await writeLastSemanticEventToLocalRunState(localRunRecord, stampedEvent);
      }

      if (event === 'run.summary') {
        terminalSummary = stampedEvent;

        if (localRunRecord !== undefined) {
          await writeFile(
            join(localRunRecord, 'result.json'),
            `${JSON.stringify(stampedEvent, null, 2)}\n`,
          );
        }
      }

      return stampedEvent;
    },
  };
}

/**
 * @param {string | undefined} localRunRecord
 * @param {Record<string, unknown> | undefined} event
 * @returns {Promise<void>}
 */
async function writeLastSemanticEventToLocalRunState(localRunRecord, event) {
  if (localRunRecord === undefined || event === undefined) {
    return;
  }

  const statePath = join(localRunRecord, LOCAL_RUN_STATE_FILE_NAME);
  try {
    await updateLocalRunState(statePath, currentState => ({
      ...currentState,
      lastEvent: createRunStateSemanticEvent(currentState, event),
    }));
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return;
    }

    throw error;
  }
}

/**
 * @param {import('../../local-run-state/types.js').LocalRunState} currentState
 * @param {Record<string, unknown>} event
 * @returns {Record<string, unknown>}
 */
function createRunStateSemanticEvent(currentState, event) {
  const {
    schemaVersion: _schemaVersion,
    runId: _runId,
    operation: _operation,
    operationLabelReference: _operationLabelReference,
    target: _target,
    event: name,
    at,
    ...details
  } = event;
  void _schemaVersion;
  void _runId;
  void _operation;
  void _operationLabelReference;
  void _target;

  return {
    schemaVersion: 1,
    event: name,
    operationReference: currentState.operationReference,
    normalizedOperationReference: currentState.normalizedOperationReference,
    target: currentState.target,
    ...details,
    at,
  };
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isFileNotFoundError(error) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

/**
 * @param {unknown} event
 * @returns {asserts event is OperationProgressEventName}
 */
function assertOperationProgressEventName(event) {
  if (
    typeof event === 'string' &&
    OPERATION_PROGRESS_EVENT_NAMES.has(/** @type {OperationProgressEventName} */ (event))
  ) {
    return;
  }

  throw new Error(`Unsupported PullOps progress event "${String(event)}".`);
}

/**
 * @param {Record<string, unknown>} details
 * @returns {void}
 */
function assertNoReservedEventDetailKeys(details) {
  for (const key of Object.keys(details)) {
    if (RESERVED_EVENT_DETAIL_KEYS.has(key)) {
      throw new Error(`PullOps progress event details cannot include reserved field "${key}".`);
    }
  }
}

/**
 * @param {ChildAutomationResult} child
 * @returns {{
 *   event: OperationProgressEventName,
 *   details: Record<string, unknown>,
 * }}
 */
export function createLocalPrdAutoCompleteChildProgressEvent(child) {
  return {
    event: readChildProgressEventName(child),
    details: {
      phase: 'child-coordination',
      childIssue: child.issue,
      status: child.status,
      message: child.summary,
      ...projectChildResult(child),
    },
  };
}

/**
 * @param {{
 *   children: ChildAutomationResult[],
 *   targetNumber: number,
 * }} options
 * @returns {Record<string, unknown>}
 */
export function createLocalPrdAutoCompletePhaseCompletedEvent({ children, targetNumber }) {
  return {
    phase: 'child-coordination',
    childCounts: summarizeChildCounts(children),
    message: summarizeChildCoordination(children, targetNumber),
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
export function createLocalPrdAutoCompleteParentWaitingEvent(parentPullRequest) {
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
 * @param {{
 *   operationLabelReference: string,
 *   target: { type: 'issue', number: number },
 *   startedAt: Date,
 *   finishedAt: Date,
 *   contextUsage?: OperationContextUsage | null,
 * }} options
 * @returns {Record<string, unknown>}
 */
export function createLocalPrdAutoCompleteSummary(result, options) {
  const children = readChildResults(result.children);

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

  const blockers = collectTerminalBlockers(result, children, options);
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
 * @param {ChildAutomationResult[] | undefined} children
 * @returns {ChildAutomationResult[]}
 */
function readChildResults(children) {
  return Array.isArray(children) ? children : [];
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
 * @returns {OperationProgressEventName}
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
 * @param {ChildAutomationResult[]} children
 * @param {{
 *   operationLabelReference: string,
 *   target: { type: 'issue', number: number },
 *   startedAt: Date,
 *   finishedAt: Date,
 *   contextUsage?: OperationContextUsage | null,
 * }} options
 * @returns {Record<string, unknown>[]}
 */
function collectTerminalBlockers(result, children, options) {
  /** @type {Record<string, unknown>[]} */
  const blockers = Array.isArray(result.blockers)
    ? result.blockers.map(blocker => ({ ...blocker }))
    : [];

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
    if (child.runnerJob !== undefined) {
      return undefined;
    }

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

  if (isDependencyFrontierChildBlock(child)) {
    return createRunBlocker({
      targetKind: 'issue',
      targetNumber: child.issue.number,
      phase: 'dependency',
      operationLabelReference: 'issue:implement',
      reason: 'dependency-wait',
      message: child.summary,
      retryable: true,
    });
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
 *   runnerJob?: import('../../runner/types.js').ExternalRunnerJob,
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
  const command = ['pullops', 'run', 'prd:auto-complete', String(options.target.number)];
  if (result.publicationMode === 'publish') {
    command.push('--publish', 'pr');
  }

  const firstBlocker = blockers[0];
  const description =
    typeof firstBlocker?.reason === 'string' &&
    firstBlocker.reason.includes('wait') &&
    firstBlocker.reason !== 'dependency-wait'
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
 * @param {PrdAutomationResult} result
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
 * @param {PrdAutomationResult} result
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
