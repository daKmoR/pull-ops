import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readAcceptedHeartbeatPayload } from './parentEventSink.js';

describe('readAcceptedHeartbeatPayload', () => {
  it('01: does not consume a heartbeat count when the request is refused after count validation', async () => {
    const parentRun = /** @type {import('../local-run-state/types.js').LocalRunRunLink} */ ({
      runId: '2026-06-20T010203000Z-prd-auto-complete-12',
      operationReference: 'prd:auto-complete',
      normalizedOperationReference: 'prd-auto-complete',
      target: {
        type: 'issue',
        number: 12,
      },
      statePath: '/tmp/parent/state.json',
    });
    const childRoute =
      /** @type {import('./types.js').PullOpsParentEventSinkChildRoute & { lastHeartbeatCount: number }} */ ({
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
      });
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
