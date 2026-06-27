import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/**
 * @typedef {import('./types.js').InitializeLocalRunStateOptions} InitializeLocalRunStateOptions
 * @typedef {import('./types.js').LocalRunHeartbeatEnvironment} LocalRunHeartbeatEnvironment
 * @typedef {import('./types.js').LocalRunResultStatus} LocalRunResultStatus
 * @typedef {import('./types.js').LocalRunState} LocalRunState
 * @typedef {import('./types.js').LocalRunStateRecord} LocalRunStateRecord
 * @typedef {import('./types.js').LocalRunTerminalStatus} LocalRunTerminalStatus
 * @typedef {import('./types.js').LocalRunTarget} LocalRunTarget
 * @typedef {import('./types.js').RecordLocalRunHeartbeatOptions} RecordLocalRunHeartbeatOptions
 * @typedef {import('./types.js').RecordLocalRunTerminalStatusOptions} RecordLocalRunTerminalStatusOptions
 */

export const LOCAL_RUN_HEARTBEAT_COMMAND = 'npm exec pullops -- heartbeat';
export const DEFAULT_LOCAL_RUN_HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
export const DEFAULT_LOCAL_RUN_LEASE_DURATION_MS = DEFAULT_LOCAL_RUN_HEARTBEAT_INTERVAL_MS * 2;
export const LOCAL_RUN_STATE_FILE_NAME = 'state.json';
export const LOCAL_RUN_HEARTBEAT_PROMPT_INSTRUCTIONS = [
  'Heartbeat instructions:',
  `- If the work stays active for longer than \`PULLOPS_HEARTBEAT_INTERVAL_MS\`, run \`${LOCAL_RUN_HEARTBEAT_COMMAND}\` with \`PULLOPS_RUN_STATE_PATH\` and \`PULLOPS_HEARTBEAT_TOKEN\` from the environment.`,
  '- Heartbeats are machine-only liveness updates. Do not invent semantic progress to emit one.',
].join('\n');
const LOCAL_RUN_STATE_SCHEMA_VERSION = 1;

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
export async function recordLocalRunHeartbeat({ statePath, token, at = new Date() }) {
  return await updateLocalRunState(statePath, currentState => {
    validateHeartbeatToken(currentState, token, statePath);
    assertMutableRunState(currentState, statePath);

    const heartbeatAt = at.toISOString();
    return {
      ...currentState,
      heartbeatAt,
      leaseExpiresAt: new Date(at.getTime() + currentState.leaseDurationMs).toISOString(),
      lastEvent: currentState.lastEvent,
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
}) {
  const normalizedOperationReference = normalizeOperationReferenceForPath(operationReference);
  const runId = basename(runRecordDirectory);
  const statePath = join(runRecordDirectory, LOCAL_RUN_STATE_FILE_NAME);
  const heartbeatToken = randomUUID();
  const heartbeatAt = createdAt.toISOString();
  const leaseExpiresAt = new Date(createdAt.getTime() + leaseDurationMs).toISOString();
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
    leaseExpiresAt,
    lastEvent: createRunStartedEvent({
      operationReference,
      normalizedOperationReference,
      phase,
      target,
      at: heartbeatAt,
    }),
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
  };
}

/**
 * @param {string} statePath
 * @param {(state: LocalRunState) => LocalRunState | Promise<LocalRunState>} updater
 * @returns {Promise<LocalRunState>}
 */
export async function updateLocalRunState(statePath, updater) {
  const currentState = await readLocalRunState(statePath);
  const nextState = await updater(currentState);
  await writeLocalRunState(statePath, nextState);
  return nextState;
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
  if (typeof state.leaseExpiresAt !== 'string' || state.leaseExpiresAt.trim() === '') {
    throw new Error(`Local run state at ${statePath} is missing leaseExpiresAt.`);
  }
  if (!isRecord(state.lastEvent)) {
    throw new Error(`Local run state at ${statePath} is missing lastEvent.`);
  }
  if (!Array.isArray(state.childRuns)) {
    throw new Error(`Local run state at ${statePath} must include childRuns as an array.`);
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
 * @param {string} path
 * @returns {Promise<void>}
 */
async function safeRemove(path) {
  try {
    await rm(path, { force: true });
  } catch {
    // Ignore cleanup failures for temporary files.
  }
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
