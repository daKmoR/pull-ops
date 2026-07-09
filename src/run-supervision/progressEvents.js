import { appendFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import {
  LOCAL_RUN_STATE_FILE_NAME,
  updateLocalRunState,
} from '../local-run-state/localRunState.js';

/**
 * @typedef {import('../cli/types.js').WritableLike} WritableLike
 * @typedef {import('./types.js').OperationProgressEventName} OperationProgressEventName
 * @typedef {import('./types.js').OperationProgressEventWriter} OperationProgressEventWriter
 * @typedef {import('./types.js').SupervisedRunTarget} SupervisedRunTarget
 */

const OPERATION_PROGRESS_EVENT_NAMES = new Set(
  /** @type {OperationProgressEventName[]} */ ([
    'run.started',
    'phase.started',
    'phase.completed',
    'ticket.started',
    'ticket.progress',
    'child.heartbeat',
    'ticket.completed',
    'ticket.blocked',
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
    'ticket.started',
    'ticket.progress',
    'ticket.completed',
    'ticket.blocked',
    'waiting',
  ]),
);

/**
 * Whether an event carries semantic progress. Liveness signals such as
 * `child.heartbeat` are not semantic and never advance the run state's
 * last event; `run.summary` is terminal rather than semantic.
 *
 * @param {OperationProgressEventName} event
 * @returns {boolean}
 */
export function isSemanticProgressEvent(event) {
  return RUN_STATE_SEMANTIC_EVENT_NAMES.has(event);
}

/**
 * @param {{
 *   stdout: WritableLike,
 *   operation: string,
 *   operationLabelReference: string,
 *   runId: string,
 *   target: SupervisedRunTarget,
 * }} options
 * @returns {OperationProgressEventWriter}
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

      if (isSemanticProgressEvent(event)) {
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
 * @param {import('../local-run-state/types.js').LocalRunState} currentState
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
