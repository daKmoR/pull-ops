import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

/**
 * @typedef {import('../cli/types.js').OperationProgressEventWriter} OperationProgressEventWriter
 * @typedef {import('../local-run-state/types.js').LocalRunRunLink} LocalRunRunLink
 * @typedef {import('./types.js').PullOpsParentEventSink} PullOpsParentEventSink
 * @typedef {import('./types.js').PullOpsParentEventSinkChildEnvironment} PullOpsParentEventSinkChildEnvironment
 * @typedef {import('./types.js').PullOpsParentEventSinkChildRoute} PullOpsParentEventSinkChildRoute
 */

const MAX_SINK_REQUEST_BYTES = 64 * 1024;

/**
 * @param {{
 *   parentRun: LocalRunRunLink,
 *   progressEventWriter: OperationProgressEventWriter,
 * }} options
 * @returns {Promise<PullOpsParentEventSink>}
 */
export async function startPullOpsParentEventSink({ parentRun, progressEventWriter }) {
  const token = randomUUID();
  /** @type {Map<string, PullOpsParentEventSinkChildRoute & { lastHeartbeatCount: number }>} */
  const routes = new Map();

  const server = createServer(async (request, response) => {
    await handleParentEventSinkRequest({
      request,
      response,
      token,
      parentRun,
      routes,
      progressEventWriter,
    });
  });

  await listen(server);
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Parent event sink did not bind to a TCP port.');
  }

  return {
    endpoint: `http://127.0.0.1:${address.port}/events`,
    token,
    createChildEnvironment(route) {
      routes.set(route.childRunLink.runId, {
        ...route,
        lastHeartbeatCount: 0,
      });
      return {
        PULLOPS_PARENT_EVENT_SINK_URL: `http://127.0.0.1:${address.port}/events`,
        PULLOPS_PARENT_EVENT_SINK_TOKEN: token,
        PULLOPS_PARENT_RUN_ID: parentRun.runId,
        PULLOPS_CHILD_RUN_ID: route.childRunLink.runId,
        PULLOPS_CHILD_ISSUE_NUMBER: String(route.childIssueNumber),
        PULLOPS_CHILD_LOCAL_RUN_RECORD: route.localRunRecord,
        PULLOPS_CHILD_RUN_STATE_PATH: route.childRunLink.statePath,
      };
    },
    closeChildRoute(childRunId) {
      routes.delete(childRunId);
    },
    async close() {
      await closeServer(server);
    },
  };
}

/**
 * @param {{
 *   env: NodeJS.ProcessEnv,
 *   localRunRecord: string,
 *   runState: import('../local-run-state/types.js').LocalRunState,
 * }} options
 * @returns {Promise<{ delivered: boolean, warning?: string }>}
 */
export async function publishHeartbeatToParentEventSink({ env, localRunRecord, runState }) {
  const endpoint = readOptionalEnv(env.PULLOPS_PARENT_EVENT_SINK_URL);
  if (endpoint === undefined) {
    return { delivered: false };
  }

  const token = readOptionalEnv(env.PULLOPS_PARENT_EVENT_SINK_TOKEN);
  const parentRunId = readOptionalEnv(env.PULLOPS_PARENT_RUN_ID);
  const childRunId = readOptionalEnv(env.PULLOPS_CHILD_RUN_ID);
  const childIssueNumber = readOptionalIntegerEnv(env.PULLOPS_CHILD_ISSUE_NUMBER);
  const childLocalRunRecord = readOptionalEnv(env.PULLOPS_CHILD_LOCAL_RUN_RECORD) ?? localRunRecord;
  const childRunStatePath = readOptionalEnv(env.PULLOPS_CHILD_RUN_STATE_PATH);
  if (
    token === undefined ||
    parentRunId === undefined ||
    childRunId === undefined ||
    childIssueNumber === undefined ||
    childRunStatePath === undefined
  ) {
    return {
      delivered: false,
      warning: 'Parent event sink delivery skipped because child heartbeat routing was incomplete.',
    };
  }

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        type: 'heartbeat',
        parentRunId,
        childRunId,
        childIssueNumber,
        localRunRecord: childLocalRunRecord,
        childRunStatePath,
        heartbeatAt: runState.heartbeatAt,
        leaseExpiresAt: runState.leaseExpiresAt,
        heartbeatCount: runState.heartbeatCount ?? 0,
        heartbeatSummary: runState.heartbeatSummary,
        completedNonHeartbeatStepsSinceHeartbeat:
          runState.completedNonHeartbeatStepsSinceHeartbeat ?? 0,
      }),
    });

    if (response.ok) {
      return { delivered: true };
    }

    return {
      delivered: false,
      warning: `Parent event sink delivery failed with HTTP ${response.status}.`,
    };
  } catch (error) {
    return {
      delivered: false,
      warning: `Parent event sink delivery failed: ${getErrorMessage(error)}`,
    };
  }
}

/**
 * @param {{
 *   request: import('node:http').IncomingMessage,
 *   response: import('node:http').ServerResponse,
 *   token: string,
 *   parentRun: LocalRunRunLink,
 *   routes: Map<string, PullOpsParentEventSinkChildRoute & { lastHeartbeatCount: number }>,
 *   progressEventWriter: OperationProgressEventWriter,
 * }} options
 * @returns {Promise<void>}
 */
export async function handleParentEventSinkRequest({
  request,
  response,
  token,
  parentRun,
  routes,
  progressEventWriter,
}) {
  try {
    if (request.method !== 'POST' || request.url !== '/events') {
      writeSinkResponse(response, 404, { status: 'not-found' });
      return;
    }

    const auth = request.headers.authorization;
    if (auth !== `Bearer ${token}`) {
      writeSinkResponse(response, 401, { status: 'refused', reason: 'unauthorized' });
      return;
    }

    const payload = await readJsonRequestBody(request);
    const heartbeat = readAcceptedHeartbeatPayload(payload, { parentRun, routes });
    const route = routes.get(heartbeat.childRunId);
    if (route !== undefined) {
      route.lastHeartbeatCount = heartbeat.heartbeatCount;
    }
    await progressEventWriter.emit('child.heartbeat', {
      phase: 'child-coordination',
      childIssue: {
        number: heartbeat.childIssueNumber,
      },
      childRunId: heartbeat.childRunId,
      localRunRecord: heartbeat.localRunRecord,
      childRunStatePath: heartbeat.childRunStatePath,
      heartbeatAt: heartbeat.heartbeatAt,
      leaseExpiresAt: heartbeat.leaseExpiresAt,
      heartbeatCount: heartbeat.heartbeatCount,
      ...(heartbeat.heartbeatSummary === undefined
        ? {}
        : { heartbeatSummary: heartbeat.heartbeatSummary }),
      completedNonHeartbeatStepsSinceHeartbeat:
        heartbeat.completedNonHeartbeatStepsSinceHeartbeat,
    });
    writeSinkResponse(response, 202, { status: 'accepted' });
  } catch (error) {
    writeSinkResponse(response, readSinkErrorStatus(error), {
      status: 'refused',
      reason: getErrorMessage(error),
    });
  }
}

/**
 * @param {import('node:http').IncomingMessage} request
 * @returns {Promise<unknown>}
 */
async function readJsonRequestBody(request) {
  /** @type {Buffer[]} */
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > MAX_SINK_REQUEST_BYTES) {
      throw createSinkError('Parent event sink request is too large.', 413);
    }
    chunks.push(buffer);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    throw createSinkError(
      `Parent event sink request must be valid JSON: ${getErrorMessage(error)}`,
    );
  }
}

/**
 * @param {unknown} payload
 * @param {{
 *   parentRun: LocalRunRunLink,
 *   routes: Map<string, PullOpsParentEventSinkChildRoute & { lastHeartbeatCount: number }>,
 * }} options
 * @returns {{
 *   childRunId: string,
 *   childIssueNumber: number,
 *   localRunRecord: string,
 *   childRunStatePath: string,
 *   heartbeatAt: string,
 *   leaseExpiresAt: string,
 *   heartbeatCount: number,
 *   heartbeatSummary?: string,
 *   completedNonHeartbeatStepsSinceHeartbeat: number,
 * }}
 */
export function readAcceptedHeartbeatPayload(payload, { parentRun, routes }) {
  if (!isRecord(payload)) {
    throw createSinkError('Parent event sink payload must be a JSON object.');
  }
  if (payload.type !== 'heartbeat') {
    throw createSinkError('Parent event sink only accepts heartbeat payloads.');
  }
  if (payload.parentRunId !== parentRun.runId) {
    throw createSinkError('Heartbeat parent run id did not match the active parent run.', 403);
  }

  const childRunId = readRequiredString(payload.childRunId, 'childRunId');
  const route = routes.get(childRunId);
  if (route === undefined) {
    throw createSinkError('Heartbeat child run id is not active for this parent run.', 403);
  }

  const childIssueNumber = readRequiredInteger(payload.childIssueNumber, 'childIssueNumber');
  if (childIssueNumber !== route.childIssueNumber) {
    throw createSinkError('Heartbeat child issue did not match the active child route.', 403);
  }

  const heartbeatCount = readRequiredInteger(payload.heartbeatCount, 'heartbeatCount');
  if (heartbeatCount <= route.lastHeartbeatCount) {
    throw createSinkError('Heartbeat count must increase monotonically.', 409);
  }

  const localRunRecord = readRequiredString(payload.localRunRecord, 'localRunRecord');
  if (localRunRecord !== route.localRunRecord) {
    throw createSinkError('Heartbeat local run record did not match the active child route.', 403);
  }

  const childRunStatePath = readRequiredString(payload.childRunStatePath, 'childRunStatePath');
  if (childRunStatePath !== route.childRunLink.statePath) {
    throw createSinkError(
      'Heartbeat child run state path did not match the active child route.',
      403,
    );
  }

  return {
    childRunId,
    childIssueNumber,
    localRunRecord,
    childRunStatePath,
    heartbeatAt: readRequiredString(payload.heartbeatAt, 'heartbeatAt'),
    leaseExpiresAt: readRequiredString(payload.leaseExpiresAt, 'leaseExpiresAt'),
    heartbeatCount,
    ...readOptionalHeartbeatSummary(payload.heartbeatSummary),
    completedNonHeartbeatStepsSinceHeartbeat: readOptionalNonNegativeInteger(
      payload.completedNonHeartbeatStepsSinceHeartbeat,
      'completedNonHeartbeatStepsSinceHeartbeat',
    ),
  };
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {string}
 */
function readRequiredString(value, name) {
  if (typeof value === 'string' && value.trim() !== '') {
    return value;
  }

  throw createSinkError(`Heartbeat ${name} must be a non-empty string.`);
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {number}
 */
function readRequiredInteger(value, name) {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }

  throw createSinkError(`Heartbeat ${name} must be a positive integer.`);
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {number}
 */
function readOptionalNonNegativeInteger(value, name) {
  if (value === undefined) {
    return 0;
  }
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return value;
  }

  throw createSinkError(`Heartbeat ${name} must be a non-negative integer.`);
}

/**
 * @param {unknown} value
 * @returns {{ heartbeatSummary?: string }}
 */
function readOptionalHeartbeatSummary(value) {
  if (value === undefined) {
    return {};
  }
  if (typeof value === 'string') {
    return { heartbeatSummary: value };
  }

  throw createSinkError('Heartbeat heartbeatSummary must be a string when present.');
}

/**
 * @param {import('node:http').ServerResponse} response
 * @param {number} statusCode
 * @param {Record<string, unknown>} body
 * @returns {void}
 */
function writeSinkResponse(response, statusCode, body) {
  response.writeHead(statusCode, { 'content-type': 'application/json' });
  response.end(`${JSON.stringify(body)}\n`);
}

/**
 * @param {import('node:http').Server} server
 * @returns {Promise<void>}
 */
async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(undefined);
    });
  });
}

/**
 * @param {import('node:http').Server} server
 * @returns {Promise<void>}
 */
async function closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close(error => {
      if (error === undefined) {
        resolve(undefined);
      } else {
        reject(error);
      }
    });
  });
}

/**
 * @param {string} message
 * @param {number} [statusCode]
 * @returns {Error & { statusCode?: number }}
 */
function createSinkError(message, statusCode = 400) {
  const error = /** @type {Error & { statusCode?: number }} */ (new Error(message));
  error.statusCode = statusCode;
  return error;
}

/**
 * @param {unknown} error
 * @returns {number}
 */
function readSinkErrorStatus(error) {
  if (
    typeof error === 'object' &&
    error !== null &&
    'statusCode' in error &&
    typeof error.statusCode === 'number'
  ) {
    return error.statusCode;
  }

  return 500;
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @param {string | undefined} value
 * @returns {string | undefined}
 */
function readOptionalEnv(value) {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * @param {string | undefined} value
 * @returns {number | undefined}
 */
function readOptionalIntegerEnv(value) {
  const normalized = readOptionalEnv(value);
  if (normalized === undefined) {
    return undefined;
  }

  const parsed = Number(normalized);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
