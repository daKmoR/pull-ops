import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * @typedef {import('./types.js').InitializeLocalRunStateOptions} InitializeLocalRunStateOptions
 * @typedef {import('./types.js').LocalRunHeartbeatEnvironment} LocalRunHeartbeatEnvironment
 * @typedef {import('./types.js').LocalRunChildRun} LocalRunChildRun
 * @typedef {import('./types.js').LocalRunResultStatus} LocalRunResultStatus
 * @typedef {import('./types.js').LocalRunRunLink} LocalRunRunLink
 * @typedef {import('./types.js').LocalRunState} LocalRunState
 * @typedef {import('./types.js').LocalRunStateRecord} LocalRunStateRecord
 * @typedef {import('./types.js').LocalRunTerminalStatus} LocalRunTerminalStatus
 * @typedef {import('./types.js').LocalRunTarget} LocalRunTarget
 * @typedef {import('./types.js').RecordLocalRunCompletedNonHeartbeatStepOptions} RecordLocalRunCompletedNonHeartbeatStepOptions
 * @typedef {import('./types.js').RecordLocalRunHeartbeatOptions} RecordLocalRunHeartbeatOptions
 * @typedef {import('./types.js').RecordLocalRunChildRunOptions} RecordLocalRunChildRunOptions
 * @typedef {import('./types.js').RecordLocalRunTerminalStatusOptions} RecordLocalRunTerminalStatusOptions
 */

export const LOCAL_RUN_HEARTBEAT_COMMAND = 'npm exec pullops -- heartbeat';
export const DEFAULT_LOCAL_RUN_HEARTBEAT_INTERVAL_MS = 4 * 60 * 1000;
export const DEFAULT_LOCAL_RUN_LEASE_DURATION_MS = DEFAULT_LOCAL_RUN_HEARTBEAT_INTERVAL_MS * 2;
export const LOCAL_RUN_STATE_FILE_NAME = 'state.json';
const LOCAL_RUN_NPM_CACHE_DIRECTORY_NAME = 'npm-cache';
const LOCAL_RUN_STATE_SCHEMA_VERSION = 1;
const LOCAL_RUN_STATE_LOCK_RETRY_DELAY_MS = 25;
const LOCAL_RUN_STATE_LOCK_STALE_MS = 30 * 1000;
const LOCAL_RUN_STATE_LOCK_TIMEOUT_MS = 10 * 1000;

/**
 * @param {InitializeLocalRunStateOptions} options
 * @returns {Promise<LocalRunStateRecord>}
 */
export async function initializeLocalRunState(options) {
  const record = createLocalRunStateRecord(options);
  await writeLocalRunState(record.statePath, record.state);
  return record;
}

/**
 * @param {string} statePath
 * @returns {Promise<LocalRunState>}
 */
export async function readLocalRunState(statePath) {
  const rawState = await readFile(statePath, 'utf8');
  try {
    return parseLocalRunState(JSON.parse(rawState), statePath);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Local run state at ${statePath} must be valid JSON.`, { cause: error });
    }

    throw error;
  }
}

/**
 * @param {RecordLocalRunHeartbeatOptions} options
 * @returns {Promise<LocalRunState>}
 */
export async function recordLocalRunHeartbeat({ statePath, token, summary, at = new Date() }) {
  return await updateLocalRunState(statePath, currentState => {
    validateHeartbeatToken(currentState, token, statePath);
    assertMutableRunState(currentState, statePath);

    const heartbeatAt = at.toISOString();
    const heartbeatSummary = normalizeHeartbeatSummary(summary);
    return {
      ...currentState,
      heartbeatAt,
      heartbeatSummary,
      heartbeatCount: (currentState.heartbeatCount ?? 0) + 1,
      completedNonHeartbeatStepsSinceHeartbeat: 0,
      leaseExpiresAt: new Date(at.getTime() + currentState.leaseDurationMs).toISOString(),
      lastEvent: currentState.lastEvent,
    };
  });
}

/**
 * @param {RecordLocalRunCompletedNonHeartbeatStepOptions} options
 * @returns {Promise<LocalRunState>}
 */
export async function recordLocalRunCompletedNonHeartbeatStep({ statePath }) {
  return await updateLocalRunState(statePath, currentState => {
    assertMutableRunState(currentState, statePath);
    return {
      ...currentState,
      completedNonHeartbeatStepsSinceHeartbeat:
        (currentState.completedNonHeartbeatStepsSinceHeartbeat ?? 0) + 1,
    };
  });
}

/**
 * @param {RecordLocalRunTerminalStatusOptions} options
 * @returns {Promise<LocalRunState>}
 */
export async function recordLocalRunTerminalStatus({
  statePath,
  status,
  summary,
  phase,
  at = new Date(),
}) {
  const terminalStatus = assertLocalRunTerminalStatus(status);
  return await updateLocalRunState(statePath, currentState => {
    const nextPhase = phase ?? currentState.phase;
    const isoAt = at.toISOString();

    return {
      ...currentState,
      status: terminalStatus,
      phase: nextPhase,
      lastEvent: {
        schemaVersion: LOCAL_RUN_STATE_SCHEMA_VERSION,
        event: 'run.summary',
        operationReference: currentState.operationReference,
        normalizedOperationReference: currentState.normalizedOperationReference,
        target: currentState.target,
        phase: nextPhase,
        status: terminalStatus,
        summary,
        at: isoAt,
      },
    };
  });
}

/**
 * @param {RecordLocalRunChildRunOptions} options
 * @returns {Promise<LocalRunState>}
 */
export async function recordLocalRunChildRun({ statePath, childRun }) {
  return await updateLocalRunState(statePath, currentState => {
    assertMutableRunState(currentState, statePath);
    return {
      ...currentState,
      childRuns: upsertLocalRunChildRun(currentState.childRuns, childRun),
    };
  });
}

/**
 * @param {LocalRunResultStatus} status
 * @returns {LocalRunTerminalStatus}
 */
export function mapLocalRunResultStatusToTerminalStatus(status) {
  switch (status) {
    case 'accepted':
    case 'blocked':
    case 'refused':
    case 'failed':
      return status;
    case 'approved':
    case 'changes_requested':
    case 'addressed':
    case 'implemented':
    case 'fixed':
    case 'resolved':
    case 'planned':
    case 'skipped':
      return 'accepted';
    default:
      throw new Error(`Unsupported local run result status "${status}".`);
  }
}

/**
 * @param {InitializeLocalRunStateOptions} options
 * @returns {LocalRunStateRecord}
 */
export function createLocalRunStateRecord({
  runRecordDirectory,
  operationReference,
  target,
  publicationMode,
  runGoal = 'operation',
  phase = 'run',
  createdAt = new Date(),
  heartbeatIntervalMs = DEFAULT_LOCAL_RUN_HEARTBEAT_INTERVAL_MS,
  leaseDurationMs = DEFAULT_LOCAL_RUN_LEASE_DURATION_MS,
  parentRun,
}) {
  const normalizedOperationReference = normalizeOperationReferenceForPath(operationReference);
  const runId = basename(runRecordDirectory);
  const statePath = join(runRecordDirectory, LOCAL_RUN_STATE_FILE_NAME);
  const heartbeatToken = randomUUID();
  const heartbeatAt = createdAt.toISOString();
  const leaseExpiresAt = new Date(createdAt.getTime() + leaseDurationMs).toISOString();
  const runLink = createLocalRunLink({
    runRecordDirectory,
    operationReference,
    target,
    statePath,
  });
  const state = /** @type {LocalRunState} */ ({
    schemaVersion: LOCAL_RUN_STATE_SCHEMA_VERSION,
    runId,
    operationReference,
    normalizedOperationReference,
    target,
    publicationMode,
    runGoal,
    status: 'running',
    phase,
    heartbeatToken,
    heartbeatIntervalMs,
    leaseDurationMs,
    heartbeatAt,
    heartbeatCount: 0,
    completedNonHeartbeatStepsSinceHeartbeat: 0,
    leaseExpiresAt,
    lastEvent: createRunStartedEvent({
      operationReference,
      normalizedOperationReference,
      phase,
      target,
      at: heartbeatAt,
    }),
    ...(parentRun === undefined ? {} : { parentRun }),
    childRuns: [],
  });

  return {
    statePath,
    state,
    heartbeatEnvironment: createLocalRunHeartbeatEnvironment({
      statePath,
      heartbeatToken,
      heartbeatIntervalMs,
    }),
    runLink,
  };
}

/**
 * @param {{
 *   statePath: string,
 *   heartbeatToken: string,
 *   heartbeatIntervalMs: number,
 * }} options
 * @returns {LocalRunHeartbeatEnvironment}
 */
export function createLocalRunHeartbeatEnvironment({
  statePath,
  heartbeatToken,
  heartbeatIntervalMs,
}) {
  return {
    PULLOPS_HEARTBEAT_COMMAND: LOCAL_RUN_HEARTBEAT_COMMAND,
    PULLOPS_RUN_STATE_PATH: statePath,
    PULLOPS_HEARTBEAT_TOKEN: heartbeatToken,
    PULLOPS_HEARTBEAT_INTERVAL_MS: String(heartbeatIntervalMs),
    npm_config_cache: join(dirname(statePath), LOCAL_RUN_NPM_CACHE_DIRECTORY_NAME),
  };
}

/**
 * @param {string} statePath
 * @param {(state: LocalRunState) => LocalRunState | Promise<LocalRunState>} updater
 * @returns {Promise<LocalRunState>}
 */
export async function updateLocalRunState(statePath, updater) {
  return await withLocalRunStateLock(statePath, async () => {
    const currentState = await readLocalRunState(statePath);
    const nextState = await updater(currentState);
    await writeLocalRunState(statePath, nextState);
    return nextState;
  });
}

/**
 * @param {string} statePath
 * @param {LocalRunState} state
 * @returns {Promise<void>}
 */
export async function writeLocalRunState(statePath, state) {
  const directory = dirname(statePath);
  await mkdir(directory, { recursive: true });
  const tempPath = join(directory, `${basename(statePath)}.${randomUUID()}.tmp`);

  try {
    await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`);
    await rename(tempPath, statePath);
  } finally {
    await safeRemove(tempPath);
  }
}

/**
 * @param {string} statePath
 * @returns {Promise<LocalRunStateRecord>}
 */
export async function readLocalRunStateRecord(statePath) {
  const state = await readLocalRunState(statePath);
  return {
    statePath,
    state,
    heartbeatEnvironment: createLocalRunHeartbeatEnvironment({
      statePath,
      heartbeatToken: state.heartbeatToken,
      heartbeatIntervalMs: state.heartbeatIntervalMs,
    }),
    runLink: createLocalRunLink({
      runRecordDirectory: dirname(statePath),
      operationReference: state.operationReference,
      target: state.target,
      statePath,
    }),
  };
}

/**
 * @param {string} runRecordDirectory
 * @returns {Promise<LocalRunStateRecord>}
 */
export async function readLocalRunStateRecordFromDirectory(runRecordDirectory) {
  return await readLocalRunStateRecord(join(runRecordDirectory, LOCAL_RUN_STATE_FILE_NAME));
}

/**
 * @param {unknown} value
 * @param {string} statePath
 * @returns {LocalRunState}
 */
function parseLocalRunState(value, statePath) {
  if (!isRecord(value)) {
    throw new Error(`Local run state at ${statePath} must be a JSON object.`);
  }

  const state = /** @type {Partial<LocalRunState> & Record<string, unknown>} */ (value);
  if (state.schemaVersion !== LOCAL_RUN_STATE_SCHEMA_VERSION) {
    throw new Error(`Local run state at ${statePath} must use schemaVersion 1.`);
  }
  if (typeof state.runId !== 'string' || state.runId.trim() === '') {
    throw new Error(`Local run state at ${statePath} is missing runId.`);
  }
  if (typeof state.operationReference !== 'string' || state.operationReference.trim() === '') {
    throw new Error(`Local run state at ${statePath} is missing operationReference.`);
  }
  if (
    typeof state.normalizedOperationReference !== 'string' ||
    state.normalizedOperationReference.trim() === ''
  ) {
    throw new Error(`Local run state at ${statePath} is missing normalizedOperationReference.`);
  }
  if (!isTargetRecord(state.target)) {
    throw new Error(`Local run state at ${statePath} is missing target.`);
  }
  if (state.publicationMode !== 'dry-run' && state.publicationMode !== 'publish') {
    throw new Error(`Local run state at ${statePath} has an invalid publicationMode.`);
  }
  if (state.runGoal !== 'operation' && state.runGoal !== 'finalized') {
    throw new Error(`Local run state at ${statePath} has an invalid runGoal.`);
  }
  if (typeof state.status !== 'string' || state.status.trim() === '') {
    throw new Error(`Local run state at ${statePath} is missing status.`);
  }
  if (typeof state.phase !== 'string' || state.phase.trim() === '') {
    throw new Error(`Local run state at ${statePath} is missing phase.`);
  }
  if (typeof state.heartbeatToken !== 'string' || state.heartbeatToken.trim() === '') {
    throw new Error(`Local run state at ${statePath} is missing heartbeatToken.`);
  }
  if (
    typeof state.heartbeatIntervalMs !== 'number' ||
    !Number.isFinite(state.heartbeatIntervalMs)
  ) {
    throw new Error(`Local run state at ${statePath} has an invalid heartbeatIntervalMs.`);
  }
  if (typeof state.leaseDurationMs !== 'number' || !Number.isFinite(state.leaseDurationMs)) {
    throw new Error(`Local run state at ${statePath} has an invalid leaseDurationMs.`);
  }
  if (typeof state.heartbeatAt !== 'string' || state.heartbeatAt.trim() === '') {
    throw new Error(`Local run state at ${statePath} is missing heartbeatAt.`);
  }
  if (state.heartbeatSummary !== undefined && typeof state.heartbeatSummary !== 'string') {
    throw new Error(`Local run state at ${statePath} has an invalid heartbeatSummary.`);
  }
  if (
    state.heartbeatCount !== undefined &&
    (!Number.isInteger(state.heartbeatCount) || state.heartbeatCount < 0)
  ) {
    throw new Error(`Local run state at ${statePath} has an invalid heartbeatCount.`);
  }
  if (
    state.completedNonHeartbeatStepsSinceHeartbeat !== undefined &&
    (!Number.isInteger(state.completedNonHeartbeatStepsSinceHeartbeat) ||
      state.completedNonHeartbeatStepsSinceHeartbeat < 0)
  ) {
    throw new Error(
      `Local run state at ${statePath} has an invalid completedNonHeartbeatStepsSinceHeartbeat.`,
    );
  }
  if (typeof state.leaseExpiresAt !== 'string' || state.leaseExpiresAt.trim() === '') {
    throw new Error(`Local run state at ${statePath} is missing leaseExpiresAt.`);
  }
  if (!isRecord(state.lastEvent)) {
    throw new Error(`Local run state at ${statePath} is missing lastEvent.`);
  }
  if (state.parentRun !== undefined && !isRunLinkRecord(state.parentRun)) {
    throw new Error(`Local run state at ${statePath} has an invalid parentRun.`);
  }
  if (!Array.isArray(state.childRuns)) {
    throw new Error(`Local run state at ${statePath} must include childRuns as an array.`);
  }
  if (!state.childRuns.every(isLocalRunChildRunRecord)) {
    throw new Error(`Local run state at ${statePath} must include valid childRuns.`);
  }

  return /** @type {LocalRunState} */ (state);
}

/**
 * @param {LocalRunState} state
 * @param {string} token
 * @param {string} statePath
 */
function validateHeartbeatToken(state, token, statePath) {
  if (typeof token !== 'string' || token.trim() === '') {
    throw new LocalRunHeartbeatError(`Missing heartbeat token for ${statePath}.`);
  }

  if (state.heartbeatToken !== token) {
    throw new LocalRunHeartbeatError(`Heartbeat token mismatch for ${statePath}.`);
  }
}

/**
 * @param {LocalRunState} state
 * @param {string} statePath
 */
function assertMutableRunState(state, statePath) {
  if (isTerminalOrLegacySkippedStatus(state.status)) {
    throw new LocalRunHeartbeatError(`Local run state at ${statePath} is already terminal.`);
  }
}

/**
 * @param {string | undefined} summary
 * @returns {string | undefined}
 */
function normalizeHeartbeatSummary(summary) {
  if (summary === undefined) {
    return undefined;
  }

  const trimmed = summary.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * @param {string} status
 * @returns {LocalRunTerminalStatus}
 */
function assertLocalRunTerminalStatus(status) {
  if (
    status === 'accepted' ||
    status === 'blocked' ||
    status === 'refused' ||
    status === 'failed'
  ) {
    return status;
  }

  throw new Error(
    `Local run terminal status for state.json must use a terminal status; received "${status}".`,
  );
}

/**
 * @param {string} status
 * @returns {boolean}
 */
function isTerminalOrLegacySkippedStatus(status) {
  return (
    status === 'accepted' ||
    status === 'blocked' ||
    status === 'refused' ||
    status === 'failed' ||
    status === 'skipped'
  );
}

/**
 * @param {LocalRunChildRun[]} childRuns
 * @param {LocalRunChildRun} childRun
 * @returns {LocalRunChildRun[]}
 */
function upsertLocalRunChildRun(childRuns, childRun) {
  const index = childRuns.findIndex(existing => existing.runId === childRun.runId);
  if (index === -1) {
    return [...childRuns, childRun];
  }

  const nextChildRuns = [...childRuns];
  nextChildRuns[index] = childRun;
  return nextChildRuns;
}

/**
 * @param {{
 *   runRecordDirectory: string,
 *   operationReference: string,
 *   target: LocalRunTarget,
 *   statePath?: string,
 * }} options
 * @returns {LocalRunRunLink}
 */
export function createLocalRunLink({
  runRecordDirectory,
  operationReference,
  target,
  statePath = join(runRecordDirectory, LOCAL_RUN_STATE_FILE_NAME),
}) {
  return {
    runId: basename(runRecordDirectory),
    operationReference,
    normalizedOperationReference: normalizeOperationReferenceForPath(operationReference),
    target,
    statePath,
  };
}

/**
 * @param {object} options
 * @param {string} options.operationReference
 * @param {string} options.normalizedOperationReference
 * @param {string} options.phase
 * @param {LocalRunTarget} options.target
 * @param {string} options.at
 * @returns {Record<string, unknown>}
 */
function createRunStartedEvent({
  operationReference,
  normalizedOperationReference,
  phase,
  target,
  at,
}) {
  return {
    schemaVersion: LOCAL_RUN_STATE_SCHEMA_VERSION,
    event: 'run.started',
    operationReference,
    normalizedOperationReference,
    target,
    phase,
    status: 'running',
    message: `Started local ${operationReference} run for ${formatTarget(target)}.`,
    at,
  };
}

/**
 * @param {LocalRunTarget} target
 * @returns {string}
 */
function formatTarget(target) {
  return `${target.type} #${target.number}`;
}

/**
 * @param {string} reference
 * @returns {string}
 */
export function normalizeOperationReferenceForPath(reference) {
  return reference
    .trim()
    .toLowerCase()
    .replaceAll(':', '-')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {value is LocalRunTarget}
 */
function isTargetRecord(value) {
  return (
    isRecord(value) &&
    (value.type === 'issue' || value.type === 'pr') &&
    typeof value.number === 'number' &&
    Number.isInteger(value.number) &&
    value.number > 0
  );
}

/**
 * @param {unknown} value
 * @returns {value is LocalRunRunLink}
 */
function isRunLinkRecord(value) {
  return (
    isRecord(value) &&
    typeof value.runId === 'string' &&
    typeof value.operationReference === 'string' &&
    typeof value.normalizedOperationReference === 'string' &&
    isTargetRecord(value.target) &&
    typeof value.statePath === 'string' &&
    value.runId.trim() !== '' &&
    value.operationReference.trim() !== '' &&
    value.normalizedOperationReference.trim() !== '' &&
    value.statePath.trim() !== ''
  );
}

/**
 * @param {unknown} value
 * @returns {value is LocalRunChildRun}
 */
function isLocalRunChildRunRecord(value) {
  if (!isRunLinkRecord(value)) {
    return false;
  }

  const childRun = /** @type {Record<string, unknown> & LocalRunRunLink} */ (value);
  return (
    typeof childRun.status === 'string' &&
    childRun.status.trim() !== '' &&
    typeof childRun.startedAt === 'string' &&
    childRun.startedAt.trim() !== '' &&
    typeof childRun.updatedAt === 'string' &&
    childRun.updatedAt.trim() !== '' &&
    (childRun.summary === undefined || typeof childRun.summary === 'string')
  );
}

/**
 * @param {string} path
 * @returns {Promise<void>}
 */
async function safeRemove(path) {
  try {
    await rm(path, { force: true, recursive: true });
  } catch {
    // Ignore cleanup failures for temporary files.
  }
}

/**
 * @template T
 * @param {string} statePath
 * @param {() => Promise<T>} operation
 * @returns {Promise<T>}
 */
async function withLocalRunStateLock(statePath, operation) {
  const lockPath = `${statePath}.lock`;
  const deadline = Date.now() + LOCAL_RUN_STATE_LOCK_TIMEOUT_MS;

  while (true) {
    try {
      await mkdir(lockPath);
      break;
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }

      if (await clearStaleLocalRunStateLock(lockPath)) {
        continue;
      }

      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for the local run state lock at ${lockPath}.`, {
          cause: error,
        });
      }

      await delay(LOCAL_RUN_STATE_LOCK_RETRY_DELAY_MS);
    }
  }

  try {
    return await operation();
  } finally {
    await safeRemove(lockPath);
  }
}

/**
 * @param {string} lockPath
 * @returns {Promise<boolean>}
 */
async function clearStaleLocalRunStateLock(lockPath) {
  try {
    const lockStats = await stat(lockPath);
    if (Date.now() - lockStats.mtimeMs <= LOCAL_RUN_STATE_LOCK_STALE_MS) {
      return false;
    }

    await safeRemove(lockPath);
    return true;
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return true;
    }

    throw error;
  }
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isAlreadyExistsError(error) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isFileNotFoundError(error) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

export class LocalRunHeartbeatError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = 'LocalRunHeartbeatError';
  }
}
