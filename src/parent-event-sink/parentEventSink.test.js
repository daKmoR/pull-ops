import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';

import {
  handleParentEventSinkRequest,
  readAcceptedHeartbeatPayload,
} from './parentEventSink.js';

describe('readAcceptedHeartbeatPayload', () => {
  it('01: does not consume a heartbeat count when the request is refused after count validation', async () => {
    const parentRun = createParentRun();
    const childRoute = createChildRoute();
    /** @type {Map<string, import('./types.js').PullOpsParentEventSinkChildRoute & { lastHeartbeatCount: number }>} */
    const routes = new Map([[childRoute.childRunLink.runId, childRoute]]);

    assert.throws(() => {
      readAcceptedHeartbeatPayload(
        {
          type: 'heartbeat',
          parentRunId: parentRun.runId,
          childRunId: childRoute.childRunLink.runId,
          childIssueNumber: childRoute.childIssueNumber,
          localRunRecord: childRoute.localRunRecord,
          childRunStatePath: childRoute.childRunLink.statePath,
          heartbeatAt: '',
          leaseExpiresAt: '2026-06-20T01:07:04.000Z',
          heartbeatCount: 1,
          heartbeatSummary: 'invalid heartbeat',
          completedNonHeartbeatStepsSinceHeartbeat: 0,
        },
        { parentRun, routes },
      );
    }, /heartbeatAt must be a non-empty string/i);
    assert.equal(childRoute.lastHeartbeatCount, 0);

    const heartbeat = readAcceptedHeartbeatPayload(
      {
        type: 'heartbeat',
        parentRunId: parentRun.runId,
        childRunId: childRoute.childRunLink.runId,
        childIssueNumber: childRoute.childIssueNumber,
        localRunRecord: childRoute.localRunRecord,
        childRunStatePath: childRoute.childRunLink.statePath,
        heartbeatAt: '2026-06-20T01:02:04.000Z',
        leaseExpiresAt: '2026-06-20T01:07:04.000Z',
        heartbeatCount: 1,
        heartbeatSummary: 'accepted heartbeat',
        completedNonHeartbeatStepsSinceHeartbeat: 0,
      },
      { parentRun, routes },
    );
    assert.equal(heartbeat.heartbeatCount, 1);
    assert.equal(childRoute.lastHeartbeatCount, 0);

    childRoute.lastHeartbeatCount = heartbeat.heartbeatCount;

    assert.throws(() => {
      readAcceptedHeartbeatPayload(
        {
          type: 'heartbeat',
          parentRunId: parentRun.runId,
          childRunId: childRoute.childRunLink.runId,
          childIssueNumber: childRoute.childIssueNumber,
          localRunRecord: childRoute.localRunRecord,
          childRunStatePath: childRoute.childRunLink.statePath,
          heartbeatAt: '2026-06-20T01:03:04.000Z',
          leaseExpiresAt: '2026-06-20T01:08:04.000Z',
          heartbeatCount: 1,
          heartbeatSummary: 'duplicate heartbeat',
          completedNonHeartbeatStepsSinceHeartbeat: 0,
        },
        { parentRun, routes },
      );
    }, /must increase monotonically/i);
  });
});

describe('handleParentEventSinkRequest', () => {
  it('01: rejects invalid sink requests without emitting child heartbeat events', async () => {
    const parentRun = createParentRun();
    const progressEventWriter = createProgressEventWriterSpy(parentRun);
    const token = 'test-parent-event-sink-token';
    /** @type {Map<string, import('./types.js').PullOpsParentEventSinkChildRoute & { lastHeartbeatCount: number }>} */
    const routes = new Map();
    const route = createChildRoute();
    routes.set(route.childRunLink.runId, route);
    const acceptedBody = createHeartbeatBody({ parentRun, route, heartbeatCount: 1 });

    assert.equal(
      await sendSinkRequest({
        body: acceptedBody,
        token: 'not-the-token',
        expectedToken: token,
        parentRun,
        routes,
        progressEventWriter,
      }),
      401,
    );
    assert.equal(
      await sendSinkRequest({
        body: { ...acceptedBody, parentRunId: 'stale-parent-run' },
        token,
        expectedToken: token,
        parentRun,
        routes,
        progressEventWriter,
      }),
      403,
    );
    assert.equal(
      await sendSinkRequest({
        body: { ...acceptedBody, childRunId: 'inactive-child-run' },
        token,
        expectedToken: token,
        parentRun,
        routes,
        progressEventWriter,
      }),
      403,
    );
    assert.equal(
      await sendSinkRequest({
        body: { ...acceptedBody, childIssueNumber: 35 },
        token,
        expectedToken: token,
        parentRun,
        routes,
        progressEventWriter,
      }),
      403,
    );
    assert.equal(
      await sendSinkRequest({
        rawBody: '{',
        token,
        expectedToken: token,
        parentRun,
        routes,
        progressEventWriter,
      }),
      400,
    );
    assert.equal(
      await sendSinkRequest({
        body: { ...acceptedBody, heartbeatAt: '' },
        token,
        expectedToken: token,
        parentRun,
        routes,
        progressEventWriter,
      }),
      400,
    );
    assert.equal(progressEventWriter.events.length, 0);

    assert.equal(
      await sendSinkRequest({
        body: acceptedBody,
        token,
        expectedToken: token,
        parentRun,
        routes,
        progressEventWriter,
      }),
      202,
    );
    assert.deepEqual(
      readEventNamesAndCounts(progressEventWriter),
      [['child.heartbeat', 1]],
    );

    assert.equal(
      await sendSinkRequest({
        body: acceptedBody,
        token,
        expectedToken: token,
        parentRun,
        routes,
        progressEventWriter,
      }),
      409,
    );
    assert.equal(
      await sendSinkRequest({
        body: { ...acceptedBody, heartbeatCount: 0 },
        token,
        expectedToken: token,
        parentRun,
        routes,
        progressEventWriter,
      }),
      400,
    );
    assert.equal(
      await sendSinkRequest({
        body: { ...acceptedBody, heartbeatCount: 1 },
        token,
        expectedToken: token,
        parentRun,
        routes,
        progressEventWriter,
      }),
      409,
    );
    assert.deepEqual(
      readEventNamesAndCounts(progressEventWriter),
      [['child.heartbeat', 1]],
    );

    assert.equal(
      await sendSinkRequest({
        body: { ...acceptedBody, heartbeatCount: 2 },
        token,
        expectedToken: token,
        parentRun,
        routes,
        progressEventWriter,
      }),
      202,
    );
    routes.delete(route.childRunLink.runId);
    assert.equal(
      await sendSinkRequest({
        body: { ...acceptedBody, heartbeatCount: 3 },
        token,
        expectedToken: token,
        parentRun,
        routes,
        progressEventWriter,
      }),
      403,
    );
    assert.deepEqual(
      readEventNamesAndCounts(progressEventWriter),
      [
        ['child.heartbeat', 1],
        ['child.heartbeat', 2],
      ],
    );
  });
});

/**
 * @returns {import('../local-run-state/types.js').LocalRunRunLink}
 */
function createParentRun() {
  return {
    runId: '2026-06-20T010203000Z-prd-auto-complete-12',
    operationReference: 'prd:auto-complete',
    normalizedOperationReference: 'prd-auto-complete',
    target: {
      type: 'issue',
      number: 12,
    },
    statePath: '/tmp/parent/state.json',
  };
}

/**
 * @returns {import('./types.js').PullOpsParentEventSinkChildRoute & { lastHeartbeatCount: number }}
 */
function createChildRoute() {
  return {
    childRunLink: {
      runId: '2026-06-20T010204000Z-issue-implement-34',
      operationReference: 'issue:implement',
      normalizedOperationReference: 'issue-implement',
      target: {
        type: 'issue',
        number: 34,
      },
      statePath: '/tmp/child/state.json',
    },
    childIssueNumber: 34,
    localRunRecord: '/tmp/child-run-record',
    lastHeartbeatCount: 0,
  };
}

/**
 * @param {import('../local-run-state/types.js').LocalRunRunLink} parentRun
 * @returns {import('../cli/types.js').OperationProgressEventWriter & {
 *   events: Array<{ event: string, heartbeatCount?: unknown } & Record<string, unknown>>,
 * }}
 */
function createProgressEventWriterSpy(parentRun) {
  /** @type {Array<{ event: string, heartbeatCount?: unknown } & Record<string, unknown>>} */
  const events = [];
  return {
    runId: parentRun.runId,
    operationLabelReference: parentRun.operationReference,
    target: parentRun.target,
    events,
    async bindLocalRunRecord() {},
    async emit(event, details = {}) {
      const emitted = { event, ...details };
      events.push(emitted);
      return emitted;
    },
  };
}

/**
 * @param {{
 *   parentRun: import('../local-run-state/types.js').LocalRunRunLink,
 *   route: import('./types.js').PullOpsParentEventSinkChildRoute,
 *   heartbeatCount: number,
 * }} options
 * @returns {Record<string, unknown>}
 */
function createHeartbeatBody({ parentRun, route, heartbeatCount }) {
  return {
    type: 'heartbeat',
    parentRunId: parentRun.runId,
    childRunId: route.childRunLink.runId,
    childIssueNumber: route.childIssueNumber,
    localRunRecord: route.localRunRecord,
    childRunStatePath: route.childRunLink.statePath,
    heartbeatAt: '2026-06-20T01:02:04.000Z',
    leaseExpiresAt: '2026-06-20T01:07:04.000Z',
    heartbeatCount,
    heartbeatSummary: `heartbeat ${heartbeatCount}`,
    completedNonHeartbeatStepsSinceHeartbeat: 0,
  };
}

/**
 * @param {{
 *   body?: Record<string, unknown>,
 *   rawBody?: string,
 *   token: string,
 *   expectedToken: string,
 *   parentRun: import('../local-run-state/types.js').LocalRunRunLink,
 *   routes: Map<string, import('./types.js').PullOpsParentEventSinkChildRoute & { lastHeartbeatCount: number }>,
 *   progressEventWriter: import('../cli/types.js').OperationProgressEventWriter,
 * }} options
 * @returns {Promise<number>}
 */
async function sendSinkRequest({
  body,
  rawBody,
  token,
  expectedToken,
  parentRun,
  routes,
  progressEventWriter,
}) {
  const request = Readable.from([rawBody ?? JSON.stringify(body)]);
  Object.assign(request, {
    method: 'POST',
    url: '/events',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
  });

  const response = createResponseSpy();
  await handleParentEventSinkRequest({
    request: /** @type {import('node:http').IncomingMessage} */ (request),
    response: /** @type {import('node:http').ServerResponse} */ (
      /** @type {unknown} */ (response)
    ),
    token: expectedToken,
    parentRun,
    routes,
    progressEventWriter,
  });
  return response.statusCode;
}

/**
 * @param {{ events: Array<{ event: string, heartbeatCount?: unknown }> }} progressEventWriter
 * @returns {unknown[][]}
 */
function readEventNamesAndCounts(progressEventWriter) {
  return progressEventWriter.events.map(event => [event.event, event.heartbeatCount]);
}

/**
 * @returns {{ statusCode: number, writeHead(statusCode: number): void, end(chunk: string): void, body: string }}
 */
function createResponseSpy() {
  return {
    statusCode: 0,
    body: '',
    writeHead(statusCode) {
      this.statusCode = statusCode;
    },
    end(chunk) {
      this.body = chunk;
    },
  };
}
